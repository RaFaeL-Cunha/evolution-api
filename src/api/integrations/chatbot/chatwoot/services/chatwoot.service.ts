import { InstanceDto } from '@api/dto/instance.dto';
import { Options, Quoted, SendAudioDto, SendMediaDto, SendTextDto } from '@api/dto/sendMessage.dto';
import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
import { getChatwootSendErrorMessage } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-error-message';
import { chatwootImport } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import { PrismaRepository } from '@api/repository/repository.service';
import { CacheService } from '@api/services/cache.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Events } from '@api/types/wa.types';
import { Chatwoot, ConfigService, Database, HttpServer } from '@config/env.config';
import { Logger } from '@config/logger.config';
import ChatwootClient, {
  ChatwootAPIConfig,
  contact,
  contact_inboxes,
  conversation,
  conversation_show,
  generic_id,
  inbox,
} from '@figuro/chatwoot-sdk';
import { request as chatwootRequest } from '@figuro/chatwoot-sdk/dist/core/request';
import { Chatwoot as ChatwootModel, Contact as ContactModel, Message as MessageModel } from '@prisma/client';
import i18next from '@utils/i18n';
import { sendTelemetry } from '@utils/sendTelemetry';
import axios from 'axios';
import { WAMessageContent, WAMessageKey } from 'baileys';
import dayjs from 'dayjs';
import FormData from 'form-data';
import { Jimp, JimpMime } from 'jimp';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import Long from 'long';
import mimeTypes from 'mime-types';
import path from 'path';
import { Readable } from 'stream';

interface ChatwootMessage {
  messageId?: number;
  inboxId?: number;
  conversationId?: number;
  contactInboxSourceId?: string;
  isRead?: boolean;
}

/**
 * Helper simples para retry com backoff customizado
 * Opção Balanceada: 4 retries em ~25s (dentro do timeout de 40s do Chatwoot)
 * Tentativa 1: imediato
 * Tentativa 2: +5s (total: 5s)
 * Tentativa 3: +8s (total: 13s)
 * Tentativa 4: +12s (total: 25s)
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 4,
  operationName: string = 'Operação',
): Promise<T> {
  const logger = new Logger('RetryHelper');

  // Delays customizados para ficar dentro de 25s
  const delays = [0, 5000, 8000, 12000]; // 0s, 5s, 8s, 12s

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();

      if (attempt > 1) {
        logger.log(`✅ ${operationName} bem-sucedida na tentativa ${attempt}/${maxAttempts}`);
      }

      return result;
    } catch (error) {
      // Extrai mensagem de erro útil
      let errorMsg = 'Erro desconhecido';
      if (error?.message) {
        errorMsg = error.message;
      } else if (typeof error === 'object') {
        if (error?.exists === false) {
          errorMsg = 'Número não está no WhatsApp';
        } else {
          errorMsg = JSON.stringify(error);
        }
      } else {
        errorMsg = String(error);
      }

      const errorStatus = error?.status || error?.response?.status || 'unknown';

      if (attempt === maxAttempts) {
        logger.error(
          `❌ ${operationName} falhou após ${maxAttempts} tentativas:\n` +
            `  Erro: ${errorMsg}\n` +
            `  Status: ${errorStatus}\n` +
            `  Tipo: ${error?.code || 'unknown'}`,
        );
        throw new Error(`Falhou apos ${maxAttempts} tentativas: ${operationName} - ${errorMsg}`);
      }

      const delayMs = delays[attempt] || 12000; // Fallback para 12s

      logger.warn(
        `⚠️ ${operationName} falhou (tentativa ${attempt}/${maxAttempts}):\n` +
          `  Erro: ${errorMsg}\n` +
          `  Status: ${errorStatus}\n` +
          `  Aguardando ${delayMs}ms antes da próxima tentativa...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`Falhou apos ${maxAttempts} tentativas: ${operationName}`);
}

/**
 * Cache simples para evitar duplicatas de mensagens
 *
 * ESTRATEGIA ANTI-DUPLICATA:
 * 1. Cache de "em processamento" (processing) - TTL curto (5s) para prevenir race condition
 * 2. Cache de "processado" (processed) - TTL longo (5min) para evitar reprocessamento
 *
 * Isso permite:
 * - Bloquear duplicatas que chegam ao mesmo tempo (race condition)
 * - Permitir retentativas em caso de erro (processing expira rapido)
 * - Evitar reprocessamento de mensagens ja enviadas (processed dura mais)
 */
class MessageDeduplicationCache {
  private readonly logger = new Logger('MessageDeduplication');
  private cache: Map<string, number> = new Map(); // messageId -> timestamp
  private contentCache: Map<string, number> = new Map(); // contentHash -> timestamp (processado)
  private processingCache: Map<string, number> = new Map(); // contentHash -> timestamp (em processamento)
  private readonly TTL_MS = 300000; // 5 minutos
  private readonly CONTENT_TTL_MS = 30000; // 30 segundos para conteúdo (janela de duplicação)
  private readonly PROCESSING_TTL_MS = 5000; // 5 segundos para "em processamento"

  /**
   * Gera hash do conteúdo da mensagem para detecção de duplicatas
   * USA timestamp arredondado para 1 segundo para diferenciar:
   * - Duplicatas do Baileys (mesmo timestamp ou < 1s) - BLOQUEIA
   * - Mensagens identicas legitimas (timestamps > 1s) - PERMITE
   *
   * Exemplo:
   * - Usuario manda "ola" as 10:00:00.500 -> hash: "123:ola:10:00:00"
   * - Baileys duplica "ola" as 10:00:00.800 -> hash: "123:ola:10:00:00" (BLOQUEADO)
   * - Usuario manda "ola" de novo as 10:00:02.000 -> hash: "123:ola:10:00:02" (PERMITIDO)
   */
  private generateContentHash(remoteJid: string, content: string, timestamp: number): string {
    // Arredonda timestamp para janela de 1 segundo
    // Isso permite que mensagens identicas enviadas com >1s de diferenca passem
    const roundedTimestamp = Math.floor(timestamp / 1000) * 1000;
    return `${remoteJid}:${content}:${roundedTimestamp}`;
  }

  public isDuplicate(messageId: string): boolean {
    const timestamp = this.cache.get(messageId);

    if (!timestamp) {
      return false;
    }

    // Verifica se ainda está no TTL
    if (Date.now() - timestamp > this.TTL_MS) {
      this.cache.delete(messageId);
      return false;
    }

    this.logger.verbose(`Mensagem duplicada detectada por ID: ${messageId}`);
    return true;
  }

  /**
   * Verifica se mensagem esta em processamento OU ja foi processada
   * Retorna true se for duplicata (deve ser bloqueada)
   */
  public isDuplicateByContent(remoteJid: string, content: string, timestamp: number): boolean {
    if (!content || !remoteJid) {
      return false;
    }

    const contentHash = this.generateContentHash(remoteJid, content, timestamp);
    const now = Date.now();

    // 1. Verifica se esta em processamento (race condition)
    const processingTimestamp = this.processingCache.get(contentHash);
    if (processingTimestamp) {
      const age = now - processingTimestamp;
      if (age <= this.PROCESSING_TTL_MS) {
        this.logger.warn(
          `⚠️ DUPLICATA DETECTADA - EM PROCESSAMENTO: ${remoteJid} | Age: ${age}ms | Hash: ${contentHash.substring(0, 50)}...`,
        );
        return true; // Duplicata! Outra mensagem identica esta sendo processada
      } else {
        // Expirou - remove do cache
        this.processingCache.delete(contentHash);
      }
    }

    // 2. Verifica se ja foi processada
    const processedTimestamp = this.contentCache.get(contentHash);
    if (processedTimestamp) {
      const age = now - processedTimestamp;
      if (age <= this.CONTENT_TTL_MS) {
        this.logger.warn(
          `⚠️ DUPLICATA DETECTADA - JA PROCESSADA: ${remoteJid} | Age: ${age}ms | Hash: ${contentHash.substring(0, 50)}...`,
        );
        return true; // Duplicata! Mensagem ja foi processada
      } else {
        // Expirou - remove do cache
        this.contentCache.delete(contentHash);
      }
    }

    return false; // Nao e duplicata
  }

  /**
   * Marca mensagem como "em processamento" para prevenir race condition
   * Deve ser chamado IMEDIATAMENTE apos verificar que nao e duplicata
   */
  public markAsProcessing(remoteJid: string, content: string, timestamp: number): void {
    if (!content || !remoteJid) {
      return;
    }

    const contentHash = this.generateContentHash(remoteJid, content, timestamp);
    this.processingCache.set(contentHash, Date.now());
    this.logger.verbose(
      `🔒 Marcado como EM PROCESSAMENTO: ${contentHash.substring(0, 80)} | Cache size: ${this.processingCache.size}`,
    );
  }

  /**
   * Marca mensagem como processada (sucesso ou erro)
   * Remove do cache de "em processamento" e adiciona ao cache de "processado"
   */
  public markAsProcessed(messageId: string, remoteJid?: string, content?: string, timestamp?: number): void {
    this.cache.set(messageId, Date.now());

    // Marca conteúdo também se fornecido
    if (remoteJid && content && timestamp) {
      const contentHash = this.generateContentHash(remoteJid, content, timestamp);

      // Remove do cache de processamento
      this.processingCache.delete(contentHash);

      // Adiciona ao cache de processado
      this.contentCache.set(contentHash, Date.now());

      this.logger.verbose(
        `✅ Marcado como PROCESSADO: ${contentHash.substring(0, 80)} | Cache size: ${this.contentCache.size}`,
      );
    }

    // Limpa cache periodicamente
    if (this.cache.size > 1000 || this.contentCache.size > 1000 || this.processingCache.size > 100) {
      this.cleanup();
    }
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    let contentCleaned = 0;
    let processingCleaned = 0;

    for (const [messageId, timestamp] of this.cache.entries()) {
      if (now - timestamp > this.TTL_MS) {
        this.cache.delete(messageId);
        cleaned++;
      }
    }

    for (const [contentHash, timestamp] of this.contentCache.entries()) {
      if (now - timestamp > this.CONTENT_TTL_MS) {
        this.contentCache.delete(contentHash);
        contentCleaned++;
      }
    }

    for (const [contentHash, timestamp] of this.processingCache.entries()) {
      if (now - timestamp > this.PROCESSING_TTL_MS) {
        this.processingCache.delete(contentHash);
        processingCleaned++;
      }
    }

    if (cleaned > 0 || contentCleaned > 0 || processingCleaned > 0) {
      this.logger.verbose(
        `Limpeza do cache: ${cleaned} IDs, ${contentCleaned} processados, ${processingCleaned} em processamento removidos`,
      );
    }
  }
}

// Singleton para cache de deduplicação
const messageDeduplicationCache = new MessageDeduplicationCache();

/**
 * Cache para deduplicação de mensagens DELETE
 * Previne processamento duplicado de eventos de deleção
 */
class DeleteDeduplicationCache {
  private readonly logger = new Logger('DeleteDeduplication');
  private cache: Map<string, number> = new Map();
  private readonly TTL_MS = 15000; // 15 segundos

  public isDuplicate(key: string): boolean {
    const timestamp = this.cache.get(key);

    if (!timestamp) {
      return false;
    }

    // Verifica se ainda está no TTL
    if (Date.now() - timestamp > this.TTL_MS) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  public markAsProcessed(key: string): void {
    this.cache.set(key, Date.now());

    // Cleanup periódico quando cache cresce muito
    if (this.cache.size > 1000) {
      this.cleanup();
    }
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, timestamp] of this.cache.entries()) {
      if (now - timestamp > this.TTL_MS) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.verbose(`Limpeza do cache de DELETE: ${cleaned} itens removidos`);
    }
  }
}

// Singleton para cache de deduplicação de DELETE
const deleteDeduplicationCache = new DeleteDeduplicationCache();

export class ChatwootService {
  private readonly logger = new Logger('ChatwootService');

  // Lock polling delay
  private readonly LOCK_POLLING_DELAY_MS = 300; // Delay between lock status checks

  private provider: any;

  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
    private readonly cache: CacheService,
  ) {
    // Sistema de retry via syncLostMessages (cron a cada 30min)
  }

  private pgClient = postgresClient.getChatwootConnection();

  private async getProvider(instance: InstanceDto): Promise<ChatwootModel | null> {
    const cacheKey = `${instance.instanceName}:getProvider`;
    if (await this.cache.has(cacheKey)) {
      const provider = (await this.cache.get(cacheKey)) as ChatwootModel;

      return provider;
    }

    const provider = await this.waMonitor.waInstances[instance.instanceName]?.findChatwoot();

    if (!provider) {
      this.logger.warn('provider not found');
      return null;
    }

    this.cache.set(cacheKey, provider);

    return provider;
  }

  private async clientCw(instance: InstanceDto) {
    const provider = await this.getProvider(instance);

    if (!provider) {
      this.logger.error('provider not found');
      return null;
    }

    this.provider = provider;

    const client = new ChatwootClient({
      config: this.getClientCwConfig(),
    });

    return client;
  }

  public getClientCwConfig(): ChatwootAPIConfig & { nameInbox: string; mergeBrazilContacts: boolean } {
    return {
      basePath: this.provider.url,
      with_credentials: true,
      credentials: 'include',
      token: this.provider.token,
      nameInbox: this.provider.nameInbox,
      mergeBrazilContacts: this.provider.mergeBrazilContacts,
    };
  }

  public getCache() {
    return this.cache;
  }

  public async create(instance: InstanceDto, data: ChatwootDto) {
    await this.waMonitor.waInstances[instance.instanceName].setChatwoot(data);

    if (data.autoCreate) {
      this.logger.log('Auto create chatwoot instance');
      const urlServer = this.configService.get<HttpServer>('SERVER').URL;

      await this.initInstanceChatwoot(
        instance,
        data.nameInbox ?? instance.instanceName.split('-cwId-')[0],
        `${urlServer}/chatwoot/webhook/${encodeURIComponent(instance.instanceName)}`,
        true,
        data.number,
        data.organization,
        data.logo,
      );
    }
    return data;
  }

  public async find(instance: InstanceDto): Promise<ChatwootDto> {
    try {
      return await this.waMonitor.waInstances[instance.instanceName].findChatwoot();
    } catch {
      this.logger.error('chatwoot not found');
      return { enabled: null, url: '' };
    }
  }

  public async getContact(instance: InstanceDto, id: number) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    if (!id) {
      this.logger.warn('id is required');
      return null;
    }

    const contact = await client.contact.getContactable({
      accountId: this.provider.accountId,
      id,
    });

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    return contact;
  }

  public async initInstanceChatwoot(
    instance: InstanceDto,
    inboxName: string,
    webhookUrl: string,
    qrcode: boolean,
    number: string,
    organization?: string,
    logo?: string,
  ) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    const findInbox: any = await client.inboxes.list({
      accountId: this.provider.accountId,
    });

    const checkDuplicate = findInbox.payload.map((inbox) => inbox.name).includes(inboxName);

    let inboxId: number;

    this.logger.log('Creating chatwoot inbox');
    if (!checkDuplicate) {
      const data = {
        type: 'api',
        webhook_url: webhookUrl,
      };

      const inbox = await client.inboxes.create({
        accountId: this.provider.accountId,
        data: {
          name: inboxName,
          channel: data as any,
        },
      });

      if (!inbox) {
        this.logger.warn('inbox not found');
        return null;
      }

      inboxId = inbox.id;
    } else {
      const inbox = findInbox.payload.find((inbox) => inbox.name === inboxName);

      if (!inbox) {
        this.logger.warn('inbox not found');
        return null;
      }

      inboxId = inbox.id;
    }
    this.logger.log(`Inbox created - inboxId: ${inboxId}`);

    if (!this.configService.get<Chatwoot>('CHATWOOT').BOT_CONTACT) {
      this.logger.log('Chatwoot bot contact is disabled');

      return true;
    }

    this.logger.log('Creating chatwoot bot contact');
    const contact =
      (await this.findContact(instance, '123456')) ||
      ((await this.createContact(
        instance,
        '123456',
        inboxId,
        false,
        organization ? organization : 'EvolutionAPI',
        logo ? logo : 'https://evolution-api.com/files/evolution-api-favicon.png',
      )) as any);

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    const contactId = contact.id || contact.payload.contact.id;
    this.logger.log(`Contact created - contactId: ${contactId}`);

    if (qrcode) {
      this.logger.log('QR code enabled');
      const data = {
        contact_id: contactId.toString(),
        inbox_id: inboxId.toString(),
      };

      const conversation = await client.conversations.create({
        accountId: this.provider.accountId,
        data,
      });

      if (!conversation) {
        this.logger.warn('conversation not found');
        return null;
      }

      let contentMsg = 'init';

      if (number) {
        contentMsg = `init:${number}`;
      }

      const message = await client.messages.create({
        accountId: this.provider.accountId,
        conversationId: conversation.id,
        data: {
          content: contentMsg,
          message_type: 'outgoing',
        },
      });

      if (!message) {
        this.logger.warn('conversation not found');
        return null;
      }
      this.logger.log('Init message sent');
    }

    return true;
  }

  public async createContact(
    instance: InstanceDto,
    phoneNumber: string,
    inboxId: number,
    isGroup: boolean,
    name?: string,
    avatar_url?: string,
    jid?: string,
  ) {
    try {
      const client = await this.clientCw(instance);

      if (!client) {
        this.logger.warn('client not found');
        return null;
      }

      let data: any = {};
      if (!isGroup) {
        data = {
          inbox_id: inboxId,
          name: name || phoneNumber,
          identifier: jid,
          avatar_url: avatar_url,
        };

        if ((jid && jid.includes('@')) || !jid) {
          data['phone_number'] = `+${phoneNumber}`;
        }
      } else {
        data = {
          inbox_id: inboxId,
          name: name || phoneNumber,
          identifier: phoneNumber,
          avatar_url: avatar_url,
        };
      }

      const contact = await client.contacts.create({
        accountId: this.provider.accountId,
        data,
      });

      if (!contact) {
        this.logger.warn('contact not found');
        return null;
      }

      const findContact = await this.findContact(instance, phoneNumber);

      const contactId = findContact?.id;

      await this.addLabelToContact(this.provider.nameInbox, contactId);

      return contact;
    } catch (error) {
      if ((error.status === 422 || error.response?.status === 422) && jid) {
        this.logger.warn(`Contact with identifier ${jid} creation failed (422). Checking if it already exists...`);
        const existingContact = await this.findContactByIdentifier(instance, jid);
        if (existingContact) {
          const contactId = existingContact.id;
          await this.addLabelToContact(this.provider.nameInbox, contactId);
          return existingContact;
        }
      }

      this.logger.error('Error creating contact');
      console.log(error);
      return null;
    }
  }

  public async updateContact(instance: InstanceDto, id: number, data: any) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    if (!id) {
      this.logger.warn('id is required');
      return null;
    }

    try {
      const contact = await client.contacts.update({
        accountId: this.provider.accountId,
        id,
        data,
      });

      return contact;
    } catch {
      return null;
    }
  }

  public async addLabelToContact(nameInbox: string, contactId: number) {
    try {
      const uri = this.configService.get<Chatwoot>('CHATWOOT').IMPORT.DATABASE.CONNECTION.URI;

      if (!uri) return false;

      const sqlTags = `SELECT id, taggings_count FROM tags WHERE name = $1 LIMIT 1`;
      const tagData = (await this.pgClient.query(sqlTags, [nameInbox]))?.rows[0];
      let tagId = tagData?.id;
      const taggingsCount = tagData?.taggings_count || 0;

      const sqlTag = `INSERT INTO tags (name, taggings_count) 
                      VALUES ($1, $2) 
                      ON CONFLICT (name) 
                      DO UPDATE SET taggings_count = tags.taggings_count + 1 
                      RETURNING id`;

      tagId = (await this.pgClient.query(sqlTag, [nameInbox, taggingsCount + 1]))?.rows[0]?.id;

      const sqlCheckTagging = `SELECT 1 FROM taggings 
                               WHERE tag_id = $1 AND taggable_type = 'Contact' AND taggable_id = $2 AND context = 'labels' LIMIT 1`;

      const taggingExists = (await this.pgClient.query(sqlCheckTagging, [tagId, contactId]))?.rowCount > 0;

      if (!taggingExists) {
        const sqlInsertLabel = `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at) 
                                VALUES ($1, 'Contact', $2, 'labels', NOW())`;

        await this.pgClient.query(sqlInsertLabel, [tagId, contactId]);
      }

      return true;
    } catch {
      return false;
    }
  }

  public async findContactByIdentifier(instance: InstanceDto, identifier: string) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    // Direct search by query (q) - most common way to search by identifier/email/phone
    const contact = (await (client as any).get('contacts/search', {
      params: {
        q: identifier,
        sort: 'name',
      },
    })) as any;

    if (contact && contact.data && contact.data.payload && contact.data.payload.length > 0) {
      return contact.data.payload[0];
    }

    // Fallback for older API versions or different response structures
    if (contact && contact.payload && contact.payload.length > 0) {
      return contact.payload[0];
    }

    // Try search by attribute
    const contactByAttr = (await (client as any).post('contacts/filter', {
      payload: [
        {
          attribute_key: 'identifier',
          filter_operator: 'equal_to',
          values: [identifier],
          query_operator: null,
        },
      ],
    })) as any;

    if (contactByAttr && contactByAttr.payload && contactByAttr.payload.length > 0) {
      return contactByAttr.payload[0];
    }

    // Check inside data property if using axios interceptors wrapper
    if (contactByAttr && contactByAttr.data && contactByAttr.data.payload && contactByAttr.data.payload.length > 0) {
      return contactByAttr.data.payload[0];
    }

    return null;
  }

  public async findContact(instance: InstanceDto, phoneNumber: string) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    let query: any;
    const isGroup = phoneNumber.includes('@g.us');
    const isLid = phoneNumber.includes('@lid');

    if (!isGroup) {
      // Remove @lid ou @s.whatsapp.net para buscar apenas o numero
      const cleanNumber = phoneNumber.split('@')[0].split(':')[0];
      query = `+${cleanNumber}`;

      if (isLid) {
        this.logger.verbose(`Buscando contato LID: ${phoneNumber} -> query: ${query}`);
      }
    } else {
      query = phoneNumber;
    }

    let contact: any;

    if (isGroup) {
      contact = await client.contacts.search({
        accountId: this.provider.accountId,
        q: query,
      });
    } else {
      // Tenta buscar por identifier primeiro (para LID)
      if (isLid) {
        try {
          const contactByIdentifier = await this.findContactByIdentifier(instance, phoneNumber);
          if (contactByIdentifier) {
            this.logger.verbose(`Contato LID encontrado por identifier: ${contactByIdentifier.id}`);
            return contactByIdentifier;
          }
        } catch (error) {
          this.logger.verbose(`Erro ao buscar por identifier, tentando por numero: ${error.message}`);
        }
      }

      contact = await chatwootRequest(this.getClientCwConfig(), {
        method: 'POST',
        url: `/api/v1/accounts/${this.provider.accountId}/contacts/filter`,
        body: {
          payload: this.getFilterPayload(query),
        },
      });
    }

    if (!contact && contact?.payload?.length === 0) {
      this.logger.warn('contact not found');
      return null;
    }

    if (!isGroup) {
      return contact.payload.length > 1 ? this.findContactInContactList(contact.payload, query) : contact.payload[0];
    } else {
      return contact.payload.find((contact) => contact.identifier === query);
    }
  }

  private async mergeContacts(baseId: number, mergeId: number) {
    try {
      const contact = await chatwootRequest(this.getClientCwConfig(), {
        method: 'POST',
        url: `/api/v1/accounts/${this.provider.accountId}/actions/contact_merge`,
        body: {
          base_contact_id: baseId,
          mergee_contact_id: mergeId,
        },
      });

      return contact;
    } catch {
      this.logger.error('Error merging contacts');
      return null;
    }
  }

  private async mergeBrazilianContacts(contacts: any[]) {
    try {
      const contact = await chatwootRequest(this.getClientCwConfig(), {
        method: 'POST',
        url: `/api/v1/accounts/${this.provider.accountId}/actions/contact_merge`,
        body: {
          base_contact_id: contacts.find((contact) => contact.phone_number.length === 14)?.id,
          mergee_contact_id: contacts.find((contact) => contact.phone_number.length === 13)?.id,
        },
      });

      return contact;
    } catch {
      this.logger.error('Error merging contacts');
      return null;
    }
  }

  private findContactInContactList(contacts: any[], query: string) {
    const phoneNumbers = this.getNumbers(query);
    const searchableFields = this.getSearchableFields();

    // eslint-disable-next-line prettier/prettier
    if (contacts.length === 2 && this.getClientCwConfig().mergeBrazilContacts && query.startsWith('+55')) {
      const contact = this.mergeBrazilianContacts(contacts);
      if (contact) {
        return contact;
      }
    }

    const phone = phoneNumbers.reduce(
      (savedNumber, number) => (number.length > savedNumber.length ? number : savedNumber),
      '',
    );

    const contact_with9 = contacts.find((contact) => contact.phone_number === phone);
    if (contact_with9) {
      return contact_with9;
    }

    for (const contact of contacts) {
      for (const field of searchableFields) {
        if (contact[field] && phoneNumbers.includes(contact[field])) {
          return contact;
        }
      }
    }

    return null;
  }

  private getNumbers(query: string) {
    const numbers = [];
    numbers.push(query);

    if (query.startsWith('+55') && query.length === 14) {
      const withoutNine = query.slice(0, 5) + query.slice(6);
      numbers.push(withoutNine);
    } else if (query.startsWith('+55') && query.length === 13) {
      const withNine = query.slice(0, 5) + '9' + query.slice(5);
      numbers.push(withNine);
    }

    return numbers;
  }

  private getSearchableFields() {
    return ['phone_number'];
  }

  private getFilterPayload(query: string) {
    const filterPayload = [];

    const numbers = this.getNumbers(query);
    const fieldsToSearch = this.getSearchableFields();

    fieldsToSearch.forEach((field, index1) => {
      numbers.forEach((number, index2) => {
        const queryOperator = fieldsToSearch.length - 1 === index1 && numbers.length - 1 === index2 ? null : 'OR';
        filterPayload.push({
          attribute_key: field,
          filter_operator: 'equal_to',
          values: [number.replace('+', '')],
          query_operator: queryOperator,
        });
      });
    });

    return filterPayload;
  }

  /**
   * Busca conversação existente pelo número de telefone (unifica LID e JID)
   */
  private async findExistingConversationByPhone(
    instance: InstanceDto,
    phoneNumber: string,
    inboxId: number,
  ): Promise<number | null> {
    try {
      const phoneClean = phoneNumber.split('@')[0].split(':')[0];
      const contact = await this.findContact(instance, phoneClean);

      if (!contact) {
        return null;
      }

      const client = await this.clientCw(instance);
      if (!client) {
        return null;
      }

      // Busca conversações do contato
      const conversations = (await client.contacts.listConversations({
        accountId: this.provider.accountId,
        id: contact.id,
      })) as any;

      if (!conversations || !conversations.payload) {
        return null;
      }

      // Busca conversação aberta ou pendente na inbox correta
      const existingConversation = conversations.payload.find(
        (conv: any) => conv.inbox_id === inboxId && (conv.status === 'open' || conv.status === 'pending'),
      );

      if (existingConversation) {
        this.logger.verbose(
          `✅ Conversação existente encontrada: ID ${existingConversation.id} (status: ${existingConversation.status})`,
        );
        return existingConversation.id;
      }

      return null;
    } catch (error) {
      this.logger.error(`Erro ao buscar conversação existente: ${error}`);
      return null;
    }
  }

  public async createConversation(instance: InstanceDto, body: any) {
    const { remoteJid } = body.key;
    const isGroup = remoteJid.endsWith('@g.us');

    // Verifica se remoteJid ou remoteJidAlt contem LID
    const isLidInRemoteJid = remoteJid.includes('@lid');
    const isLidInRemoteJidAlt = body.key.remoteJidAlt?.includes('@lid');

    // Determina qual campo tem o numero normal (sem @lid)
    let phoneNumber: string;
    if (!isGroup) {
      // Cenario 1: LID esta no remoteJid, numero normal no remoteJidAlt
      if (isLidInRemoteJid && body.key.remoteJidAlt && !isLidInRemoteJidAlt) {
        phoneNumber = body.key.remoteJidAlt;
        this.logger.verbose(`Cenario 1: LID no remoteJid, usando remoteJidAlt: ${phoneNumber}`);
      }
      // Cenario 2: LID esta no remoteJidAlt, numero normal no remoteJid
      else if (isLidInRemoteJidAlt && !isLidInRemoteJid) {
        phoneNumber = remoteJid;
        this.logger.verbose(`Cenario 2: LID no remoteJidAlt, usando remoteJid: ${phoneNumber}`);
      }
      // Cenario 3: LID no remoteJid, sem remoteJidAlt (busca no cache IsOnWhatsapp)
      else if (isLidInRemoteJid && !body.key.remoteJidAlt) {
        try {
          const cached = await this.prismaRepository.isOnWhatsapp.findFirst({
            where: {
              OR: [{ jidOptions: { contains: remoteJid } }, { remoteJid: remoteJid }],
            },
          });

          if (cached?.remoteJid && !cached.remoteJid.includes('@lid')) {
            phoneNumber = cached.remoteJid;
            this.logger.verbose(`Cenario 3: LID convertido via cache IsOnWhatsapp: ${remoteJid} → ${phoneNumber}`);
          } else {
            this.logger.warn(`Cenario 3: LID nao encontrado no cache IsOnWhatsapp: ${remoteJid}`);
            phoneNumber = null;
          }
        } catch (error) {
          this.logger.error(`Cenario 3: Erro ao buscar LID no cache: ${remoteJid} - ${error.message}`);
          phoneNumber = null;
        }
      }
      // Cenario 4: Nenhum LID, usa remoteJid normal
      else {
        phoneNumber = remoteJid;
      }
    } else {
      phoneNumber = remoteJid;
    }

    if (!phoneNumber && !isGroup) {
      this.logger.error(
        `phoneNumber is null - remoteJid: ${remoteJid}, remoteJidAlt: ${body.key.remoteJidAlt}, isLidInRemoteJid: ${isLidInRemoteJid}, isLidInRemoteJidAlt: ${isLidInRemoteJidAlt}`,
      );
    }

    // Usa phoneNumber como chave para unificar LID e JID normal
    const normalizedKey = isGroup ? remoteJid : phoneNumber || remoteJid;
    const cacheKey = `${instance.instanceName}:createConversation-${normalizedKey}`;
    const lockKey = `${instance.instanceName}:lock:createConversation-${normalizedKey}`;

    this.logger.verbose(
      `Normalized key: ${normalizedKey} (remoteJid: ${remoteJid}, remoteJidAlt: ${body.key.remoteJidAlt})`,
    );
    const maxWaitTime = 5000; // 5 seconds

    // Tenta obter client do Chatwoot
    const client = await this.clientCw(instance);
    if (!client) {
      this.logger.warn(`⚠️ Client Chatwoot não disponível (remoteJid: ${remoteJid}) - será recuperada pelo cron`);
      return null;
    }

    try {
      // 🔧 FIX: Processa atualização de contatos quando muda de JID para LID
      if (phoneNumber && remoteJid && !isGroup) {
        const phoneNumberClean = phoneNumber.split('@')[0].split(':')[0];

        // Busca contato pelo número de telefone
        const contact = await this.findContact(instance, phoneNumberClean);

        if (contact) {
          const needsUpdate = contact.identifier !== phoneNumber;

          if (needsUpdate) {
            this.logger.log(
              `🔄 Atualizando identifier do contato: ${contact.identifier} → ${phoneNumber} (LID: ${isLidInRemoteJid || isLidInRemoteJidAlt})`,
            );

            try {
              await this.updateContact(instance, contact.id, {
                identifier: phoneNumber,
                phone_number: `+${phoneNumberClean}`,
              });
              this.logger.log(`✅ Contato atualizado com sucesso: ${phoneNumberClean}`);
            } catch (error) {
              this.logger.warn(`⚠️ Erro ao atualizar contato, tentando merge: ${error}`);

              // Se falhar, tenta fazer merge de contatos duplicados
              const baseContact = await this.findContact(instance, phoneNumberClean);
              if (baseContact && baseContact.id !== contact.id) {
                try {
                  await this.mergeContacts(baseContact.id, contact.id);
                  this.logger.log(
                    `✅ Contatos mesclados: (${baseContact.id}) ${baseContact.phone_number} ← (${contact.id}) ${contact.phone_number}`,
                  );
                } catch (mergeError) {
                  this.logger.error(`❌ Erro ao mesclar contatos: ${mergeError}`);
                }
              }
            }
          }
        }
      }
      this.logger.verbose(`--- Start createConversation ---`);
      this.logger.verbose(`Instance: ${JSON.stringify(instance)}`);

      // If it already exists in the cache, return conversationId
      if (await this.cache.has(cacheKey)) {
        const conversationId = (await this.cache.get(cacheKey)) as number;
        this.logger.verbose(`Found conversation to: ${phoneNumber}, conversation ID: ${conversationId}`);
        let conversationExists: any;
        try {
          conversationExists = await client.conversations.get({
            accountId: this.provider.accountId,
            conversationId: conversationId,
          });
          this.logger.verbose(
            `Conversation exists: ID: ${conversationExists.id} - Name: ${conversationExists.meta.sender.name} - Identifier: ${conversationExists.meta.sender.identifier}`,
          );
        } catch (error) {
          this.logger.error(`Error getting conversation: ${error}`);
          conversationExists = false;
        }
        if (!conversationExists) {
          this.logger.verbose('Conversation does not exist, re-calling createConversation');
          this.cache.delete(cacheKey);
          return await this.createConversation(instance, body);
        }
        return conversationId;
      }

      // If lock already exists, wait until release or timeout
      if (await this.cache.has(lockKey)) {
        this.logger.warn(
          `⏳ Lock já existe para ${remoteJid}, aguardando liberação... (instância: ${instance.instanceName})`,
        );
        const start = Date.now();
        let attempts = 0;

        while (await this.cache.has(lockKey)) {
          attempts++;
          const elapsed = Date.now() - start;

          if (elapsed > maxWaitTime) {
            this.logger.error(
              `❌ TIMEOUT aguardando lock para ${remoteJid} após ${elapsed}ms (${attempts} tentativas) - ` +
                `Instância: ${instance.instanceName} - Possível deadlock!`,
            );
            // Força liberação do lock em caso de timeout
            await this.cache.delete(lockKey);
            this.logger.warn(`🔓 Lock forçadamente liberado para ${remoteJid}`);
            break;
          }

          if (attempts % 10 === 0) {
            this.logger.verbose(`⏳ Ainda aguardando lock ${remoteJid} (${elapsed}ms, ${attempts} tentativas)`);
          }

          await new Promise((res) => setTimeout(res, this.LOCK_POLLING_DELAY_MS));

          if (await this.cache.has(cacheKey)) {
            const conversationId = (await this.cache.get(cacheKey)) as number;
            this.logger.log(`✅ Lock resolvido para ${remoteJid}, conversationId: ${conversationId}`);
            return conversationId;
          }
        }
      }

      // Adquire lock
      await this.cache.set(lockKey, true, 30);
      this.logger.log(`🔒 Lock adquirido: ${remoteJid} (instância: ${instance.instanceName}, TTL: 30s)`);

      try {
        /*
        Double check after lock
        Utilizei uma nova verificação para evitar que outra thread execute entre o terminio do while e o set lock
        */
        if (await this.cache.has(cacheKey)) {
          return (await this.cache.get(cacheKey)) as number;
        }

        const chatId = isGroup
          ? remoteJid
          : phoneNumber?.split('@')[0]?.split(':')[0] || remoteJid.split('@')[0].split(':')[0];
        let nameContact = !body.key.fromMe ? body.pushName : chatId;

        // ✅ Retry ao buscar inbox (45 segundos)
        const filterInbox = await retryWithBackoff(
          async () => {
            const inbox = await this.getInbox(instance);
            if (!inbox) throw new Error('Inbox not found');
            return inbox;
          },
          5,
          `Buscar inbox no Chatwoot (instance: ${instance.instanceName})`,
        );

        // 🔧 FIX: Verifica se já existe conversação pelo número de telefone (unifica LID e JID)
        if (!isGroup && phoneNumber) {
          const existingConversationId = await this.findExistingConversationByPhone(
            instance,
            phoneNumber,
            filterInbox.id,
          );

          if (existingConversationId) {
            this.logger.log(
              `✅ Usando conversação existente: ${existingConversationId} (unificando LID/JID para ${chatId})`,
            );
            await this.cache.set(cacheKey, existingConversationId, 1800);
            await this.cache.delete(lockKey);
            return existingConversationId;
          }
        }

        if (isGroup) {
          this.logger.verbose(`Processing group conversation`);
          const group = await this.waMonitor.waInstances[instance.instanceName].client.groupMetadata(chatId);
          this.logger.verbose(`Group metadata: JID:${group.JID} - Subject:${group?.subject || group?.Name}`);

          // Pega o participante correto, preferindo participantAlt se disponível e não for LID
          let participantJid = body.key.participant;
          if ((isLidInRemoteJid || isLidInRemoteJidAlt) && !body.key.fromMe && body.key.participantAlt) {
            // Se participantAlt não contém @lid, usa ele (é o número real)
            if (!body.key.participantAlt.includes('@lid')) {
              participantJid = body.key.participantAlt;
            }
          }

          nameContact = `${group.subject} (GROUP)`;

          if (!participantJid) {
            this.logger.warn(
              `participantJid is null - group: ${chatId}, isLidInRemoteJid: ${isLidInRemoteJid}, isLidInRemoteJidAlt: ${isLidInRemoteJidAlt}, fromMe: ${body.key.fromMe}, participantAlt: ${body.key.participantAlt}, participant: ${body.key.participant}`,
            );
            await this.cache.delete(lockKey);
            return null;
          }

          const picture_url = await this.waMonitor.waInstances[instance.instanceName].profilePicture(
            participantJid.split('@')[0],
          );
          this.logger.verbose(`Participant profile picture URL: ${JSON.stringify(picture_url)}`);

          const findParticipant = await this.findContact(instance, participantJid.split('@')[0]);

          if (findParticipant) {
            this.logger.verbose(
              `Found participant: ID:${findParticipant.id} - Name: ${findParticipant.name} - identifier: ${findParticipant.identifier}`,
            );
            if (!findParticipant.name || findParticipant.name === chatId) {
              await this.updateContact(instance, findParticipant.id, {
                name: body.pushName,
                avatar_url: picture_url.profilePictureUrl || null,
              });
            }
          } else {
            await this.createContact(
              instance,
              participantJid.split('@')[0].split(':')[0],
              filterInbox.id,
              false,
              body.pushName,
              picture_url.profilePictureUrl || null,
              participantJid,
            );
          }
        }

        const picture_url = await this.waMonitor.waInstances[instance.instanceName].profilePicture(chatId);
        this.logger.verbose(`Contact profile picture URL: ${JSON.stringify(picture_url)}`);

        this.logger.verbose(`Searching contact for: ${chatId}`);
        let contact = await this.findContact(instance, chatId);

        if (contact) {
          this.logger.verbose(`Found contact: ID:${contact.id} - Name:${contact.name}`);
        } else {
          contact = await this.createContact(
            instance,
            chatId,
            filterInbox.id,
            isGroup,
            nameContact,
            picture_url.profilePictureUrl || null,
            phoneNumber,
          );
        }

        if (!contact) {
          this.logger.warn(`Contact not created or found`);
          return null;
        }

        const contactId = contact?.payload?.id || contact?.payload?.contact?.id || contact?.id;
        this.logger.verbose(`Contact ID: ${contactId}`);

        // ✅ Retry ao listar conversações do contato (45 segundos)
        const contactConversations = await retryWithBackoff(
          async () => {
            const conversations = (await client.contacts.listConversations({
              accountId: this.provider.accountId,
              id: contactId,
            })) as any;
            if (!conversations || !conversations.payload) {
              throw new Error('No conversations found or payload is undefined');
            }
            return conversations;
          },
          5,
          `Listar conversações do contato no Chatwoot (contactId: ${contactId})`,
        );

        let inboxConversation = contactConversations.payload.find(
          (conversation) => conversation.inbox_id == filterInbox.id,
        );
        if (inboxConversation) {
          if (this.provider.reopenConversation) {
            this.logger.verbose(
              `Found conversation in reopenConversation mode: ID: ${inboxConversation.id} - Name: ${inboxConversation.meta.sender.name} - Identifier: ${inboxConversation.meta.sender.identifier}`,
            );
            if (inboxConversation && this.provider.conversationPending && inboxConversation.status !== 'open') {
              await client.conversations.toggleStatus({
                accountId: this.provider.accountId,
                conversationId: inboxConversation.id,
                data: {
                  status: 'pending',
                },
              });
            }
          } else {
            inboxConversation = contactConversations.payload.find(
              (conversation) =>
                conversation && conversation.status !== 'resolved' && conversation.inbox_id == filterInbox.id,
            );
            this.logger.verbose(`Found conversation: ${JSON.stringify(inboxConversation)}`);
          }

          if (inboxConversation) {
            this.logger.verbose(`Returning existing conversation ID: ${inboxConversation.id}`);
            this.cache.set(cacheKey, inboxConversation.id, 1800);
            return inboxConversation.id;
          }
        }

        const data = {
          contact_id: contactId.toString(),
          inbox_id: filterInbox.id.toString(),
        };

        if (this.provider.conversationPending) {
          data['status'] = 'pending';
        }

        // ✅ Retry ao criar conversação (45 segundos)
        const conversation = await retryWithBackoff(
          async () => {
            const conv = await client.conversations.create({
              accountId: this.provider.accountId,
              data,
            });
            if (!conv) throw new Error('Failed to create conversation');
            return conv;
          },
          5,
          `Criar conversação no Chatwoot (remoteJid: ${remoteJid})`,
        );

        this.logger.verbose(`New conversation created of ${remoteJid} with ID: ${conversation.id}`);
        this.cache.set(cacheKey, conversation.id, 1800);
        return conversation.id;
      } catch (error) {
        this.logger.error(`Error in createConversation: ${error}`);

        // ℹ️ Mensagem será recuperada pelo syncLostMessages (cron 30min)
        this.logger.warn(`⚠️ Falha ao criar conversação (remoteJid: ${remoteJid}) - será recuperada pelo cron`);

        return null;
      } finally {
        await this.cache.delete(lockKey);
        this.logger.log(`🔓 Lock liberado: ${remoteJid} (instância: ${instance.instanceName})`);
      }
    } catch (error) {
      this.logger.error(`Error in createConversation (outer): ${error}`);

      // ℹ️ Mensagem será recuperada pelo syncLostMessages (cron 30min)
      this.logger.warn(`⚠️ Falha ao criar conversação outer (remoteJid: ${remoteJid}) - será recuperada pelo cron`);

      return null;
    }
  }

  public async getInbox(instance: InstanceDto): Promise<inbox | null> {
    const cacheKey = `${instance.instanceName}:getInbox`;
    if (await this.cache.has(cacheKey)) {
      return (await this.cache.get(cacheKey)) as inbox;
    }

    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    const inbox = (await client.inboxes.list({
      accountId: this.provider.accountId,
    })) as any;

    if (!inbox) {
      this.logger.warn('inbox not found');
      return null;
    }

    const findByName = inbox.payload.find((inbox) => inbox.name === this.getClientCwConfig().nameInbox);

    if (!findByName) {
      this.logger.warn('inbox not found');
      return null;
    }

    this.cache.set(cacheKey, findByName);
    return findByName;
  }

  public async createMessage(
    instance: InstanceDto,
    conversationId: number,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    privateMessage?: boolean,
    attachments?: {
      content: unknown;
      encoding: string;
      filename: string;
    }[],
    messageBody?: any,
    sourceId?: string,
    quotedMsg?: MessageModel,
  ) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    const replyToIds = await this.getReplyToIds(messageBody, instance);

    const sourceReplyId = quotedMsg?.chatwootMessageId || null;

    // ✅ Retry com backoff exponencial (45 segundos)
    const message = await retryWithBackoff(
      async () => {
        const msg = await client.messages.create({
          accountId: this.provider.accountId,
          conversationId: conversationId,
          data: {
            content: content,
            message_type: messageType,
            attachments: attachments,
            private: privateMessage || false,
            source_id: sourceId,
            content_attributes: {
              ...replyToIds,
            },
            source_reply_id: sourceReplyId ? sourceReplyId.toString() : null,
          },
        });
        if (!msg) throw new Error('Failed to create message');
        return msg;
      },
      5,
      `Criar mensagem no Chatwoot (conversationId: ${conversationId})`,
    );

    return message;
  }

  public async getOpenConversationByContact(
    instance: InstanceDto,
    inbox: inbox,
    contact: generic_id & contact,
  ): Promise<conversation> {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    const conversations = (await client.contacts.listConversations({
      accountId: this.provider.accountId,
      id: contact.id,
    })) as any;

    return (
      conversations.payload.find(
        (conversation) => conversation.inbox_id === inbox.id && conversation.status === 'open',
      ) || undefined
    );
  }

  public async createBotMessage(
    instance: InstanceDto,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    attachments?: {
      content: unknown;
      encoding: string;
      filename: string;
    }[],
  ) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    const contact = await this.findContact(instance, '123456');

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    const filterInbox = await this.getInbox(instance);

    if (!filterInbox) {
      this.logger.warn('inbox not found');
      return null;
    }

    const conversation = await this.getOpenConversationByContact(instance, filterInbox, contact);

    if (!conversation) {
      this.logger.warn('conversation not found');
      return;
    }

    const message = await client.messages.create({
      accountId: this.provider.accountId,
      conversationId: conversation.id,
      data: {
        content: content,
        message_type: messageType,
        attachments: attachments,
      },
    });

    if (!message) {
      this.logger.warn('message not found');
      return null;
    }

    return message;
  }

  private async sendData(
    conversationId: number,
    fileStream: Readable,
    fileName: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    content?: string,
    instance?: InstanceDto,
    messageBody?: any,
    sourceId?: string,
    quotedMsg?: MessageModel,
  ) {
    if (sourceId && this.isImportHistoryAvailable()) {
      const messageAlreadySaved = await chatwootImport.getExistingSourceIds([sourceId], conversationId);
      if (messageAlreadySaved) {
        if (messageAlreadySaved.size > 0) {
          this.logger.warn('Message already saved on chatwoot');
          return null;
        }
      }
    }
    const data = new FormData();

    if (content) {
      data.append('content', content);
    }

    data.append('message_type', messageType);

    data.append('attachments[]', fileStream, { filename: fileName });

    const sourceReplyId = quotedMsg?.chatwootMessageId || null;

    if (messageBody && instance) {
      const replyToIds = await this.getReplyToIds(messageBody, instance);

      if (replyToIds.in_reply_to || replyToIds.in_reply_to_external_id) {
        const content = JSON.stringify({
          ...replyToIds,
        });
        data.append('content_attributes', content);
      }
    }

    if (sourceReplyId) {
      data.append('source_reply_id', sourceReplyId.toString());
    }

    if (sourceId) {
      data.append('source_id', sourceId);
    }

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${this.provider.url}/api/v1/accounts/${this.provider.accountId}/conversations/${conversationId}/messages`,
      headers: {
        api_access_token: this.provider.token,
        ...data.getHeaders(),
      },
      data: data,
      timeout: 45000, // 🔧 FIX: Timeout de 45s (Chatwoot tem 40s, damos 5s de margem)
    };

    // ✅ Retry ao enviar mídia (45 segundos)
    const result = await retryWithBackoff(
      async () => {
        const response = await axios.request(config);
        if (!response.data) throw new Error('No data in response');
        return response.data;
      },
      5,
      `Enviar mídia ao Chatwoot (conversationId: ${conversationId})`,
    );

    return result;
  }

  public async createBotQr(
    instance: InstanceDto,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    fileStream?: Readable,
    fileName?: string,
  ) {
    const client = await this.clientCw(instance);

    if (!client) {
      this.logger.warn('client not found');
      return null;
    }

    if (!this.configService.get<Chatwoot>('CHATWOOT').BOT_CONTACT) {
      this.logger.log('Chatwoot bot contact is disabled');

      return true;
    }

    const contact = await this.findContact(instance, '123456');

    if (!contact) {
      this.logger.warn('contact not found');
      return null;
    }

    const filterInbox = await this.getInbox(instance);

    if (!filterInbox) {
      this.logger.warn('inbox not found');
      return null;
    }

    const conversation = await this.getOpenConversationByContact(instance, filterInbox, contact);

    if (!conversation) {
      this.logger.warn('conversation not found');
      return;
    }

    const data = new FormData();

    if (content) {
      data.append('content', content);
    }

    data.append('message_type', messageType);

    if (fileStream && fileName) {
      data.append('attachments[]', fileStream, { filename: fileName });
    }

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${this.provider.url}/api/v1/accounts/${this.provider.accountId}/conversations/${conversation.id}/messages`,
      headers: {
        api_access_token: this.provider.token,
        ...data.getHeaders(),
      },
      data: data,
    };

    try {
      const { data } = await axios.request(config);

      return data;
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async sendAttachment(waInstance: any, number: string, media: any, caption?: string, options?: Options) {
    try {
      // ✅ Validação inicial
      if (!media || typeof media !== 'string') {
        throw new Error(`URL de mídia inválida: ${media}`);
      }

      // Tenta detectar extensao da URL primeiro (mais confiavel)
      const urlParts = media.split('/');
      const lastPart = urlParts[urlParts.length - 1] || ''; // ✅ Fallback para string vazia
      const extensionMatch = lastPart.match(/\.([a-zA-Z0-9]+)$/); // Pega extensao

      let mimeType = '';
      let fileName = lastPart || 'file'; // ✅ Fallback para 'file'

      // Se encontrou extensao na URL, usa ela
      if (extensionMatch) {
        const ext = '.' + extensionMatch[1]; // Ex: ".jpeg"
        const lookedUpMimeType = mimeTypes.lookup(ext);
        mimeType = lookedUpMimeType ? lookedUpMimeType.toString() : '';
        this.logger.verbose(`Extensao detectada na URL: ${ext} -> mimeType: ${mimeType}`);
      }

      // Fallback: tenta com path.parse
      if (!mimeType) {
        try {
          const parsedMedia = path.parse(decodeURIComponent(media));
          const lookedUpMimeType = mimeTypes.lookup(parsedMedia?.ext);
          mimeType = lookedUpMimeType ? lookedUpMimeType.toString() : '';
          // ✅ Garante que name e ext não sejam undefined
          const name = parsedMedia?.name || 'file';
          const ext = parsedMedia?.ext || '';
          fileName = name + ext;
          this.logger.verbose(`Fallback path.parse: ${ext} -> mimeType: ${mimeType}`);
        } catch (error) {
          this.logger.warn(`Erro ao fazer parse da URL: ${error.message}`);
        }
      }

      // Se ainda nao tem mimeType, faz requisicao para pegar content-type
      if (!mimeType) {
        const parts = media.split('/');
        fileName = decodeURIComponent(parts[parts.length - 1] || 'file'); // ✅ Fallback

        this.logger.verbose(`Fazendo requisicao para obter content-type: ${media}`);
        const response = await axios.get(media, {
          responseType: 'arraybuffer',
        });
        mimeType = response.headers['content-type'] || 'application/octet-stream';
        this.logger.verbose(`Content-type do servidor: ${mimeType}`);
      }

      // Garante que mimeType seja string valida
      if (!mimeType || typeof mimeType !== 'string') {
        this.logger.warn(`mimeType invalido, usando fallback: ${mimeType}`);
        mimeType = 'application/octet-stream';
      }

      let type = 'document';

      switch (mimeType.split('/')[0]) {
        case 'image':
          type = 'image';
          break;
        case 'video':
          type = 'video';
          break;
        case 'audio':
          type = 'audio';
          break;
        default:
          type = 'document';
          break;
      }

      // 🔧 Extrai contextInfo se existir (para mensagens encaminhadas)
      const contextInfo = (options as any)?.contextInfo;

      if (type === 'audio') {
        const data: SendAudioDto = {
          number: number,
          audio: media,
          delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500,
          quoted: options?.quoted,
        };

        sendTelemetry('/message/sendWhatsAppAudio');

        // ✅ Passa contextInfo nas options para audioWhatsapp
        const audioOptions = contextInfo ? { ...options, contextInfo } : options;
        const messageSent = await waInstance?.audioWhatsapp(data, false, true, audioOptions);

        return messageSent;
      }

      const documentExtensions = ['.gif', '.svg', '.tiff', '.tif', '.dxf', '.dwg'];
      // ✅ Garante que fileName não seja undefined antes de fazer match
      const fileExtension = (fileName || '').match(/\.([a-zA-Z0-9]+)$/)?.[0] || '';
      if (type === 'image' && documentExtensions.includes(fileExtension.toLowerCase())) {
        type = 'document';
      }

      const data: SendMediaDto = {
        number: number,
        mediatype: type as any,
        fileName: fileName || 'file', // ✅ Garante que nunca seja undefined
        media: media,
        delay: 1200,
        quoted: options?.quoted,
      };

      sendTelemetry('/message/sendMedia');

      if (caption) {
        data.caption = caption;
      }

      // ✅ Passa contextInfo nas options para mediaMessage
      const mediaOptions = contextInfo ? { ...options, contextInfo } : options;
      const messageSent = await waInstance?.mediaMessage(data, false, true, mediaOptions);

      return messageSent;
    } catch (error) {
      this.logger.error(`Erro em sendAttachment: ${error.message || error}`);
      throw error; // Re-throw para que o erro seja tratado pelo caller
    }
  }

  public async onSendMessageError(instance: InstanceDto, conversation: number, error?: any) {
    this.logger.verbose(`onSendMessageError ${JSON.stringify(error)}`);

    const client = await this.clientCw(instance);

    if (!client) {
      return;
    }

    const content = getChatwootSendErrorMessage(error);

    client.messages.create({
      accountId: this.provider.accountId,
      conversationId: conversation,
      data: {
        content,
        message_type: 'outgoing',
        private: true,
      },
    });
  }

  public async receiveWebhook(instance: InstanceDto, body: any) {
    if (body.event === 'message_updated' && body.content_attributes?.deleted) {
      this.logger.log(
        `🔔 WEBHOOK DELETE RECEBIDO:\n` +
          `  Event: ${body.event}\n` +
          `  Message ID: ${body.id}\n` +
          `  Content: ${body.content?.substring(0, 100)}...\n` +
          `  Message Type: ${body.message_type}\n` +
          `  Content Attributes: ${JSON.stringify(body.content_attributes)}`,
      );
    }

    try {
      await new Promise((resolve) => setTimeout(resolve, 500));

      const client = await this.clientCw(instance);

      if (!client) {
        this.logger.warn('client not found');
        return null;
      }

      if (
        this.provider.reopenConversation === false &&
        body.event === 'conversation_status_changed' &&
        body.status === 'resolved' &&
        body.meta?.sender?.identifier
      ) {
        const keyToDelete = `${instance.instanceName}:createConversation-${body.meta.sender.identifier}`;
        this.cache.delete(keyToDelete);
      }

      if (
        !body?.conversation ||
        body.private ||
        (body.event === 'message_updated' && !body.content_attributes?.deleted)
      ) {
        return { message: 'bot' };
      }

      const chatId =
        body.conversation.meta.sender?.identifier || body.conversation.meta.sender?.phone_number.replace('+', '');
      // Chatwoot to Whatsapp
      const messageReceived = body.content
        ? body.content
            .replaceAll(/(?<!\*)\*((?!\s)([^\n*]+?)(?<!\s))\*(?!\*)/g, '_$1_') // Substitui * por _
            .replaceAll(/\*{2}((?!\s)([^\n*]+?)(?<!\s))\*{2}/g, '*$1*') // Substitui ** por *
            .replaceAll(/~{2}((?!\s)([^\n*]+?)(?<!\s))~{2}/g, '~$1~') // Substitui ~~ por ~
            .replaceAll(/(?<!`)`((?!\s)([^`*]+?)(?<!\s))`(?!`)/g, '```$1```') // Substitui ` por ```
        : body.content;

      const senderName = body?.conversation?.messages[0]?.sender?.available_name || body?.sender?.name;
      const waInstance = this.waMonitor.waInstances[instance.instanceName];
      instance.instanceId = waInstance.instanceId;

      if (body.event === 'message_updated' && body.content_attributes?.deleted) {
        this.logger.verbose(`🗑️ Tentando deletar mensagem - Chatwoot ID: ${body.id}`);

        // Tenta buscar pelo chatwootMessageId primeiro
        let message = await this.prismaRepository.message.findFirst({
          where: {
            chatwootMessageId: body.id,
            instanceId: instance.instanceId,
          },
        });

        // Se nao encontrou e tem source_id, tenta buscar por ele
        if (!message && body.source_id) {
          const whatsappId = body.source_id.replace('WAID:', '');
          this.logger.verbose(`Tentando buscar por source_id: ${whatsappId}`);

          message = await this.prismaRepository.message.findFirst({
            where: {
              instanceId: instance.instanceId,
              key: {
                path: ['id'],
                equals: whatsappId,
              },
            },
          });
        }

        if (!message) {
          this.logger.warn(
            `⚠️ Mensagem não encontrada no banco para deletar:\n` +
              `  Chatwoot ID: ${body.id}\n` +
              `  Source ID: ${body.source_id}\n` +
              `  Instance ID: ${instance.instanceId}\n` +
              `  Content: ${body.content?.substring(0, 100)}`,
          );
          return { message: 'bot' };
        }

        const key = message.key as WAMessageKey;
        const messageType = message.messageType;

        this.logger.verbose(
          `🗑️ Deletando mensagem:\n` +
            `  Chatwoot ID: ${body.id}\n` +
            `  Source ID: ${body.source_id}\n` +
            `  WhatsApp ID: ${key.id}\n` +
            `  Type: ${messageType}\n` +
            `  RemoteJid: ${key.remoteJid}\n` +
            `  FromMe: ${key.fromMe}`,
        );

        try {
          // Delete for everyone (both mobile and WhatsApp Web)
          await waInstance?.client.sendMessage(key.remoteJid, {
            delete: key,
            revoke: true,
          });

          this.logger.log(`✅ Mensagem deletada no WhatsApp - ID: ${key.id}, Type: ${messageType}`);

          await this.prismaRepository.message.deleteMany({
            where: {
              instanceId: instance.instanceId,
              chatwootMessageId: body.id,
            },
          });
        } catch (error) {
          this.logger.error(
            `❌ Erro ao deletar mensagem no WhatsApp:\n` +
              `  Error: ${error.message}\n` +
              `  Key ID: ${key.id}\n` +
              `  Type: ${messageType}\n` +
              `  Chatwoot ID: ${body.id}\n` +
              `  Source ID: ${body.source_id}`,
          );

          // Mesmo com erro, remove do banco para não ficar inconsistente
          await this.prismaRepository.message.deleteMany({
            where: {
              instanceId: instance.instanceId,
              chatwootMessageId: body.id,
            },
          });
        }

        return { message: 'bot' };
      }

      const cwBotContact = this.configService.get<Chatwoot>('CHATWOOT').BOT_CONTACT;

      if (chatId === '123456' && body.message_type === 'outgoing') {
        const command = messageReceived.replace('/', '');

        if (cwBotContact && (command.includes('init') || command.includes('iniciar'))) {
          const state = waInstance?.connectionStatus?.state;

          if (state !== 'open') {
            const number = command.split(':')[1];
            await waInstance.connectToWhatsapp(number);
          } else {
            await this.createBotMessage(
              instance,
              i18next.t('cw.inbox.alreadyConnected', {
                inboxName: body.inbox.name,
              }),
              'incoming',
            );
          }
        }

        if (command === 'clearcache') {
          this.logger.log(`[/clearcache] Limpando cache da instância ${instance.instanceName}`);
          waInstance.clearCacheChatwoot();
          this.logger.log(`[/clearcache] Cache limpo com sucesso para ${instance.instanceName}`);

          await this.createBotMessage(
            instance,
            i18next.t('cw.inbox.clearCache', {
              inboxName: body.inbox.name,
            }),
            'incoming',
          );
        }

        if (command === 'sync' || command === 'lost') {
          try {
            const chatwootConfig = await waInstance.findChatwoot();

            await this.createBotMessage(
              instance,
              '🔄 Sincronizando mensagens perdidas das últimas 10 horas...',
              'incoming',
            );

            const prepare = (message: any) => {
              // Prepara mensagem (mesmo formato do baileys)
              return message;
            };

            this.logger.log(`[/lost command] Iniciando sincronização para ${instance.instanceName}`);
            const totalSynced = await this.syncLostMessages(instance, chatwootConfig, prepare);
            this.logger.log(`[/lost command] Resultado: ${totalSynced} mensagens sincronizadas`);

            if (totalSynced > 0) {
              await this.createBotMessage(
                instance,
                `✅ Sincronização concluída! ${totalSynced} mensagem(ns) foram sincronizadas.`,
                'incoming',
              );
            } else {
              await this.createBotMessage(
                instance,
                '✅ Nenhuma mensagem perdida encontrada. Tudo está sincronizado!',
                'incoming',
              );
            }
          } catch (error) {
            this.logger.error(`[/lost command] Erro ao sincronizar mensagens: ${error.message}`);
            this.logger.error(`[/lost command] Stack: ${error.stack}`);

            // 🔧 Tenta enviar mensagem de erro (pode falhar se provider não estiver setado)
            try {
              await this.createBotMessage(
                instance,
                `❌ Erro ao sincronizar mensagens: ${error.message}\n\nTente novamente mais tarde ou contate o suporte.`,
                'incoming',
              );
            } catch (msgError) {
              this.logger.error(`[/lost command] Erro ao enviar mensagem de erro: ${msgError.message}`);
            }
          }
        }

        if (command === 'restart' || command === 'reiniciar') {
          await this.createBotMessage(instance, '🔄 Reiniciando conexão do WhatsApp...', 'incoming');

          try {
            // Usa o mesmo método do endpoint /instance/restart
            if (typeof waInstance.restart === 'function') {
              await waInstance.restart();
            } else {
              // Fallback para Baileys
              waInstance.client?.ws?.close();
              waInstance.client?.end(new Error('restart'));
            }

            await new Promise((resolve) => setTimeout(resolve, 2000)); // Aguarda 2s

            await this.createBotMessage(instance, '✅ Reconexão iniciada! Aguarde alguns segundos...', 'incoming');
          } catch (error) {
            this.logger.error(`Erro ao reiniciar instância: ${error}`);
            await this.createBotMessage(
              instance,
              '❌ Erro ao reiniciar instância. Tente novamente ou contate o suporte.',
              'incoming',
            );
          }
        }

        if (command === 'logout' || command === 'sair') {
          await this.createBotMessage(
            instance,
            '⚠️ Desconectando WhatsApp... Você precisará escanear o QR Code novamente.',
            'incoming',
          );

          try {
            // Faz logout completo (desconecta e apaga sessão)
            await waInstance?.client?.logout();
            await new Promise((resolve) => setTimeout(resolve, 2000)); // Aguarda 2s

            await this.createBotMessage(instance, '✅ Desconectado! Use /init para gerar um novo QR Code.', 'incoming');
          } catch (error) {
            this.logger.error(`Erro ao fazer logout: ${error}`);
            await this.createBotMessage(
              instance,
              '❌ Erro ao desconectar. Tente novamente ou contate o suporte.',
              'incoming',
            );
          }
        }

        if (command === 'comandos' || command === 'help' || command === 'ajuda') {
          const helpMessage = `
📋 **Comandos Disponíveis:**

**Conexão:**
• \`/init\` ou \`/iniciar\` - Conecta WhatsApp (gera QR Code)
• \`/status\` - Mostra status da conexão

**Manutenção:**
• \`/restart\` ou \`/reiniciar\` - Reconecta sem deslogar
• \`/logout\` ou \`/sair\` - Desconecta completamente (precisa QR Code novo)
• \`/sync\` ou \`/lost\` - Sincroniza mensagens perdidas (últimas 6h)
• \`/clearcache\` - Limpa cache da instância

**Ajuda:**
• \`/comandos\` ou \`/help\` ou \`/ajuda\` - Mostra esta mensagem

💡 **Dica:** Todos os comandos funcionam com ou sem \`/\`
          `.trim();

          await this.createBotMessage(instance, helpMessage, 'incoming');
        }

        if (command === 'status') {
          const state = waInstance?.connectionStatus?.state;

          if (!state) {
            await this.createBotMessage(
              instance,
              i18next.t('cw.inbox.notFound', {
                inboxName: body.inbox.name,
              }),
              'incoming',
            );
          }

          if (state) {
            await this.createBotMessage(
              instance,
              i18next.t('cw.inbox.status', {
                inboxName: body.inbox.name,
                state: state,
              }),
              'incoming',
            );
          }
        }

        if (cwBotContact && (command === 'disconnect' || command === 'desconectar')) {
          const msgLogout = i18next.t('cw.inbox.disconnect', {
            inboxName: body.inbox.name,
          });

          await this.createBotMessage(instance, msgLogout, 'incoming');

          await waInstance?.client?.logout('Log out instance: ' + instance.instanceName);
          await waInstance?.client?.ws?.close();
        }

        // ✅ Comandos do bot sempre retornam sucesso (não devem ficar vermelhos)
        return { message: 'bot' };
      }

      if (body.message_type === 'outgoing' && body?.conversation?.messages?.length && chatId !== '123456') {
        if (body?.conversation?.messages[0]?.source_id?.substring(0, 5) === 'WAID:') {
          return { message: 'bot' };
        }

        if (!waInstance && body.conversation?.id) {
          this.onSendMessageError(instance, body.conversation?.id, 'Instance not found');
          return { message: 'bot' };
        }

        let formatText: string;
        if (senderName === null || senderName === undefined) {
          formatText = messageReceived;
        } else {
          const formattedDelimiter = this.provider.signDelimiter
            ? this.provider.signDelimiter.replaceAll('\\n', '\n')
            : '\n';
          const textToConcat = this.provider.signMsg ? [`*${senderName}:*`] : [];
          textToConcat.push(messageReceived);

          formatText = textToConcat.join(formattedDelimiter);
        }

        for (const message of body.conversation.messages) {
          if (message.attachments && message.attachments.length > 0) {
            for (const attachment of message.attachments) {
              if (!messageReceived) {
                formatText = null;
              }

              // 🔧 FIX: Detecta se é anexo encaminhado e remove o indicador de texto
              let isForwardedAttachment = false;
              let forwardCountAttachment = 1;

              if (formatText && formatText.includes('↪️ _Encaminhada')) {
                isForwardedAttachment = true;

                // Detecta se tem contador (ex: "↪️ _Encaminhada 5x_")
                const forwardMatch = formatText.match(/↪️ _Encaminhada (\d+)x_/);
                if (forwardMatch) {
                  forwardCountAttachment = parseInt(forwardMatch[1], 10);
                  formatText = formatText.replace(/↪️ _Encaminhada \d+x_\n\n/, '').trim();
                } else {
                  formatText = formatText.replace(/↪️ _Encaminhada_\n\n/, '').trim();
                }

                // Se ficou vazio após remover, deixa null
                if (formatText === '') {
                  formatText = null;
                }

                this.logger.verbose(
                  `✅ Anexo encaminhado detectado - Removendo indicador de texto e usando flag nativa (count: ${forwardCountAttachment})`,
                );
              }

              const options: Options = {
                quoted: await this.getQuotedMessage(body, instance),
              };

              // Adiciona flag de encaminhamento se necessário (cast para any pois Options não tem contextInfo no tipo)
              if (isForwardedAttachment) {
                (options as any).contextInfo = {
                  isForwarded: true,
                  forwardingScore: forwardCountAttachment,
                };
              }

              let messageSent: any;
              try {
                // 🔄 Retry automático para anexos (4 tentativas = ~25 segundos)
                messageSent = await retryWithBackoff(
                  async () => {
                    const result = await this.sendAttachment(
                      waInstance,
                      chatId,
                      attachment.data_url,
                      formatText,
                      options,
                    );
                    if (!result) {
                      throw new Error('Attachment not sent');
                    }
                    return result;
                  },
                  4,
                  `Enviar anexo do SoConnect para WhatsApp (${chatId})`,
                );

                await this.updateChatwootMessageId(
                  {
                    ...messageSent,
                  },
                  {
                    messageId: body.id,
                    inboxId: body.inbox?.id,
                    conversationId: body.conversation?.id,
                    contactInboxSourceId: body.conversation?.contact_inbox?.source_id,
                  },
                  instance,
                );
              } catch (error) {
                // ❌ TODOS os erros devem ficar vermelhos no Chatwoot
                // Mensagem não foi enviada = usuário precisa saber

                this.logger.error(
                  `❌ Erro ao enviar anexo:\n` +
                    `  ChatId: ${chatId}\n` +
                    `  Attachment: ${attachment.data_url}\n` +
                    `  Status: ${error?.status || 'unknown'}\n` +
                    `  Message: ${error?.message || error}\n` +
                    `  Full Error: ${JSON.stringify(error)}`,
                );

                if (!messageSent && body.conversation?.id) {
                  this.onSendMessageError(instance, body.conversation?.id, error);
                }

                // Identifica tipo de erro e mostra mensagem apropriada
                let errorMsg = 'Erro ao enviar anexo';
                if (error?.message?.includes('timeout')) {
                  errorMsg = 'Tempo esgotado. Verifique sua conexão';
                } else if (error?.message?.includes('not connected')) {
                  errorMsg = 'WhatsApp desconectado';
                } else if (error?.message?.includes('Invalid')) {
                  errorMsg = 'Arquivo ou formato inválido';
                } else if (error?.message?.includes('too large')) {
                  errorMsg = 'Arquivo muito grande';
                }

                const cleanError = new Error(`Falha ao enviar após 4 tentativas. ${errorMsg}`);
                throw cleanError;
              }
            }
          } else {
            // ✅ Validação: Não envia texto vazio (previne erro 400)
            if (!formatText || formatText.trim() === '') {
              this.logger.warn(`[VALIDAÇÃO] Texto vazio detectado - Ignorando envio (chatId: ${chatId})`);
              return { message: 'bot' };
            }

            // 🔧 FIX: Detecta se é mensagem encaminhada e usa flag nativa do WhatsApp
            let isForwardedMessage = false;
            let forwardCount = 1;

            // Remove o indicador "↪️ Encaminhada" do texto (será substituído pela flag nativa)
            if (formatText.includes('↪️ _Encaminhada')) {
              isForwardedMessage = true;

              // Detecta se tem contador (ex: "↪️ _Encaminhada 5x_")
              const forwardMatch = formatText.match(/↪️ _Encaminhada (\d+)x_/);
              if (forwardMatch) {
                forwardCount = parseInt(forwardMatch[1], 10);
                formatText = formatText.replace(/↪️ _Encaminhada \d+x_\n\n/, '').trim();
              } else {
                formatText = formatText.replace(/↪️ _Encaminhada_\n\n/, '').trim();
              }

              this.logger.verbose(
                `✅ Mensagem encaminhada detectada - Removendo indicador de texto e usando flag nativa (count: ${forwardCount})`,
              );
            }

            const data: SendTextDto = {
              number: chatId,
              text: formatText,
              delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500,
              quoted: await this.getQuotedMessage(body, instance),
            };

            sendTelemetry('/message/sendText');

            let messageSent: any;
            try {
              // Retry automatico: 4 tentativas (~25 segundos total)
              messageSent = await retryWithBackoff(
                async () => {
                  // 🔧 Se é mensagem encaminhada, adiciona flag nativa do WhatsApp
                  if (isForwardedMessage) {
                    const result = await waInstance?.client?.sendMessage(chatId, {
                      text: formatText,
                      contextInfo: {
                        isForwarded: true,
                        forwardingScore: forwardCount,
                      },
                    });
                    if (!result) {
                      throw new Error('Mensagem nao foi enviada');
                    }
                    return result;
                  } else {
                    // Mensagem normal
                    const result = await waInstance?.textMessage(data, true);
                    if (!result) {
                      throw new Error('Mensagem nao foi enviada');
                    }
                    return result;
                  }
                },
                4,
                `Enviar mensagem para ${chatId}`,
              );

              if (Long.isLong(messageSent?.messageTimestamp)) {
                messageSent.messageTimestamp = messageSent.messageTimestamp?.toNumber();
              }

              await this.updateChatwootMessageId(
                {
                  ...messageSent,
                },
                {
                  messageId: body.id,
                  inboxId: body.inbox?.id,
                  conversationId: body.conversation?.id,
                  contactInboxSourceId: body.conversation?.contact_inbox?.source_id,
                },
                instance,
              );
            } catch (error) {
              // Mensagem de erro sempre em portugues, clara e com o numero

              // Extrai informacao util do erro
              let errorDetails = 'Erro desconhecido';
              let userFriendlyMessage = `Nao foi possivel enviar mensagem para ${chatId}`;

              if (error?.message) {
                errorDetails = error.message;

                // Traduz erros comuns para portugues claro (sempre mostra o numero)
                if (errorDetails.includes('Connection Closed') || errorDetails.includes('connection closed')) {
                  userFriendlyMessage = `WhatsApp temporariamente desconectado. Nao foi possivel enviar para ${chatId}`;
                } else if (
                  errorDetails.includes('presenceSubscribe') ||
                  errorDetails.includes('client not connected') ||
                  errorDetails.includes('reconectando')
                ) {
                  userFriendlyMessage = `WhatsApp esta reconectando. Nao foi possivel enviar para ${chatId}`;
                } else if (
                  errorDetails.includes('Timed out') ||
                  errorDetails.includes('timeout') ||
                  errorDetails.includes('Tempo esgotado')
                ) {
                  userFriendlyMessage = `Tempo esgotado ao enviar para ${chatId}`;
                } else if (
                  errorDetails.includes('rate limit') ||
                  errorDetails.includes('too many requests') ||
                  errorDetails.includes('Muitas mensagens')
                ) {
                  userFriendlyMessage = `Muitas mensagens enviadas. Aguarde alguns minutos`;
                } else if (
                  errorDetails.includes('Mensagem nao foi enviada') ||
                  errorDetails.includes('Message not sent') ||
                  errorDetails.includes('Failed to send')
                ) {
                  userFriendlyMessage = `Falha ao enviar para ${chatId}. Verifique se o WhatsApp esta conectado`;
                } else if (
                  errorDetails.includes('Invalid number') ||
                  errorDetails.includes('not a valid') ||
                  errorDetails.includes('invalido')
                ) {
                  userFriendlyMessage = `Numero ${chatId} invalido`;
                } else if (
                  errorDetails.includes('blocked') ||
                  errorDetails.includes('Blocked') ||
                  errorDetails.includes('bloqueado')
                ) {
                  userFriendlyMessage = `Nao foi possivel enviar para ${chatId}. O numero pode ter bloqueado o contato`;
                } else if (
                  errorDetails.includes('not registered') ||
                  errorDetails.includes('not on WhatsApp') ||
                  errorDetails.includes('nao esta cadastrado')
                ) {
                  userFriendlyMessage = `O numero ${chatId} nao esta no WhatsApp`;
                } else {
                  // Erro generico mas em portugues (sempre mostra o numero)
                  userFriendlyMessage = `Nao foi possivel enviar para ${chatId}. Tente novamente`;
                }
              } else if (typeof error === 'object') {
                // Se o erro for um objeto (ex: BadRequestException com dados do numero)
                if (error?.exists === false) {
                  errorDetails = `Numero ${chatId} nao esta no WhatsApp`;
                  userFriendlyMessage = `O numero ${chatId} nao existe no WhatsApp`;
                } else {
                  errorDetails = JSON.stringify(error);
                  userFriendlyMessage = `Erro ao enviar para ${chatId}. Verifique sua conexao`;
                }
              } else {
                errorDetails = String(error);
                userFriendlyMessage = `Erro ao enviar para ${chatId}. Tente novamente`;
              }

              this.logger.error(
                `❌ Erro ao enviar mensagem:\n` +
                  `  ChatId: ${chatId}\n` +
                  `  Text: ${formatText}\n` +
                  `  Status: ${error?.status || 'unknown'}\n` +
                  `  Message: ${errorDetails}\n` +
                  `  Full Error: ${JSON.stringify(error)}`,
              );

              if (!messageSent && body.conversation?.id) {
                this.onSendMessageError(instance, body.conversation?.id, error);
              }

              // Lanca erro limpo e amigavel para Chatwoot (sempre em portugues, sem prefixos tecnicos)
              throw new Error(userFriendlyMessage);
            }
          }
        }

        const chatwootRead = this.configService.get<Chatwoot>('CHATWOOT').MESSAGE_READ;
        if (chatwootRead) {
          const lastMessage = await this.prismaRepository.message.findFirst({
            where: {
              key: {
                path: ['fromMe'],
                equals: false,
              },
              instanceId: instance.instanceId,
            },
          });
          if (lastMessage && !lastMessage.chatwootIsRead) {
            const key = lastMessage.key as WAMessageKey;

            waInstance?.markMessageAsRead({
              readMessages: [
                {
                  id: key.id,
                  fromMe: key.fromMe,
                  remoteJid: key.remoteJid,
                },
              ],
            });
            const updateMessage = {
              chatwootMessageId: lastMessage.chatwootMessageId,
              chatwootConversationId: lastMessage.chatwootConversationId,
              chatwootInboxId: lastMessage.chatwootInboxId,
              chatwootContactInboxSourceId: lastMessage.chatwootContactInboxSourceId,
              chatwootIsRead: true,
            };

            await this.prismaRepository.message.updateMany({
              where: {
                instanceId: instance.instanceId,
                key: {
                  path: ['id'],
                  equals: key.id,
                },
              },
              data: updateMessage,
            });
          }
        }
      }

      if (body.message_type === 'template' && body.event === 'message_created') {
        const data: SendTextDto = {
          number: chatId,
          text: body.content.replace(/\\\r\n|\\\n|\n/g, '\n'),
          delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500,
        };

        sendTelemetry('/message/sendText');

        await waInstance?.textMessage(data);
      }

      return { message: 'bot' };
    } catch (error) {
      this.logger.error(error);

      // ❌ Retorna erro para o Chatwoot mostrar botão de reenvio
      throw error;
    }
  }

  private async updateChatwootMessageId(
    message: MessageModel,
    chatwootMessageIds: ChatwootMessage,
    instance: InstanceDto,
  ) {
    const key = message.key as WAMessageKey;

    if (!chatwootMessageIds.messageId || !key?.id) {
      return;
    }

    // Use raw SQL to avoid JSON path issues
    const result = await this.prismaRepository.$executeRaw`
      UPDATE "Message" 
      SET 
        "chatwootMessageId" = ${chatwootMessageIds.messageId},
        "chatwootConversationId" = ${chatwootMessageIds.conversationId},
        "chatwootInboxId" = ${chatwootMessageIds.inboxId},
        "chatwootContactInboxSourceId" = ${chatwootMessageIds.contactInboxSourceId},
        "chatwootIsRead" = ${chatwootMessageIds.isRead || false}
      WHERE "instanceId" = ${instance.instanceId} 
      AND "key"->>'id' = ${key.id}
    `;

    this.logger.verbose(`Update result: ${result} rows affected`);

    if (this.isImportHistoryAvailable()) {
      try {
        await chatwootImport.updateMessageSourceID(chatwootMessageIds.messageId, key.id);
      } catch (error) {
        this.logger.error(`Error updating Chatwoot message source ID: ${error}`);
      }
    }
  }

  private async getMessageByKeyId(instance: InstanceDto, keyId: string): Promise<MessageModel> {
    // Use raw SQL query to avoid JSON path issues with Prisma
    const messages = await this.prismaRepository.$queryRaw`
      SELECT * FROM "Message" 
      WHERE "instanceId" = ${instance.instanceId} 
      AND "key"->>'id' = ${keyId}
      LIMIT 1
    `;

    return (messages as MessageModel[])[0] || null;
  }

  private async getReplyToIds(
    msg: any,
    instance: InstanceDto,
  ): Promise<{ in_reply_to: string; in_reply_to_external_id: string }> {
    let inReplyTo = null;
    let inReplyToExternalId = null;

    if (msg) {
      inReplyToExternalId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? msg.contextInfo?.stanzaId;
      if (inReplyToExternalId) {
        const message = await this.getMessageByKeyId(instance, inReplyToExternalId);
        if (message?.chatwootMessageId) {
          inReplyTo = message.chatwootMessageId;
        }
      }
    }

    return {
      in_reply_to: inReplyTo,
      in_reply_to_external_id: inReplyToExternalId,
    };
  }

  private async getQuotedMessage(msg: any, instance: InstanceDto): Promise<Quoted> {
    if (msg?.content_attributes?.in_reply_to) {
      const message = await this.prismaRepository.message.findFirst({
        where: {
          chatwootMessageId: msg?.content_attributes?.in_reply_to,
          instanceId: instance.instanceId,
        },
      });

      const key = message?.key as WAMessageKey;
      const messageContent = message?.message as WAMessageContent;

      if (messageContent && key?.id) {
        return {
          key: key,
          message: messageContent,
        };
      }
    }

    return null;
  }

  private isMediaMessage(message: any) {
    const media = [
      'imageMessage',
      'documentMessage',
      'documentWithCaptionMessage',
      'audioMessage',
      'videoMessage',
      'stickerMessage',
      'viewOnceMessageV2',
    ];

    const messageKeys = Object.keys(message);

    const result = messageKeys.some((key) => media.includes(key));

    return result;
  }

  private isInteractiveButtonMessage(messageType: string, message: any) {
    return messageType === 'interactiveMessage' && message.interactiveMessage?.nativeFlowMessage?.buttons?.length > 0;
  }

  private getAdsMessage(msg: any) {
    interface AdsMessage {
      title: string;
      body: string;
      thumbnailUrl: string;
      sourceUrl: string;
    }

    const adsMessage: AdsMessage | undefined = {
      title: msg.extendedTextMessage?.contextInfo?.externalAdReply?.title || msg.contextInfo?.externalAdReply?.title,
      body: msg.extendedTextMessage?.contextInfo?.externalAdReply?.body || msg.contextInfo?.externalAdReply?.body,
      thumbnailUrl:
        msg.extendedTextMessage?.contextInfo?.externalAdReply?.thumbnailUrl ||
        msg.contextInfo?.externalAdReply?.thumbnailUrl,
      sourceUrl:
        msg.extendedTextMessage?.contextInfo?.externalAdReply?.sourceUrl || msg.contextInfo?.externalAdReply?.sourceUrl,
    };

    return adsMessage;
  }

  private getReactionMessage(msg: any) {
    interface ReactionMessage {
      key: {
        id: string;
        fromMe: boolean;
        remoteJid: string;
        participant?: string;
      };
      text: string;
    }
    const reactionMessage: ReactionMessage | undefined = msg?.reactionMessage;

    return reactionMessage;
  }

  private getTypeMessage(msg: any) {
    const types = {
      conversation: msg.conversation,
      imageMessage: msg.imageMessage?.caption,
      videoMessage: msg.videoMessage?.caption,
      extendedTextMessage: msg.extendedTextMessage?.text,
      messageContextInfo: msg.messageContextInfo?.stanzaId,
      stickerMessage: undefined,
      documentMessage: msg.documentMessage?.caption,
      documentWithCaptionMessage: msg.documentWithCaptionMessage?.message?.documentMessage?.caption,
      audioMessage: msg.audioMessage ? (msg.audioMessage.caption ?? '') : undefined,
      contactMessage: msg.contactMessage?.vcard,
      contactsArrayMessage: msg.contactsArrayMessage,
      locationMessage: msg.locationMessage,
      liveLocationMessage: msg.liveLocationMessage,
      listMessage: msg.listMessage,
      listResponseMessage: msg.listResponseMessage,
      interactiveMessage: msg.interactiveMessage,
      pollCreationMessageV3: msg.pollCreationMessageV3,
      viewOnceMessageV2:
        msg?.message?.viewOnceMessageV2?.message?.imageMessage?.url ||
        msg?.message?.viewOnceMessageV2?.message?.videoMessage?.url ||
        msg?.message?.viewOnceMessageV2?.message?.audioMessage?.url,
      secretEncryptedMessage: msg.secretEncryptedMessage,
      albumMessage: msg.albumMessage,
      associatedChildMessage: msg.associatedChildMessage,
    };

    return types;
  }

  private getMessageContent(types: any) {
    // Ignora messageContextInfo pois é apenas metadado - busca o tipo real da mensagem
    const typeKey = Object.keys(types).find((key) => key !== 'messageContextInfo' && types[key] !== undefined);

    let result = typeKey ? types[typeKey] : undefined;

    // Remove externalAdReplyBody| in Chatwoot (Already Have)
    if (result && typeof result === 'string' && result.includes('externalAdReplyBody|')) {
      result = result.split('externalAdReplyBody|').filter(Boolean).join('');
    }

    if (typeKey === 'viewOnceMessageV2') {
      return '🔒 *Mensagem de visualização única*\n\n_Esta mensagem só pode ser visualizada uma vez no celular. Por segurança, o WhatsApp não permite que ela seja acessada pela API._';
    }

    if (typeKey === 'secretEncryptedMessage') {
      return '🔐 *Mensagem criptografada*\n\n_Esta mensagem não pôde ser descriptografada. Verifique no celular para visualizar._';
    }

    if (typeKey === 'albumMessage' || typeKey === 'associatedChildMessage') {
      // Ignora mensagens de álbum (metadados) - as mídias reais já são importadas via imageMessage/videoMessage
      return null;
    }

    if (typeKey === 'pollCreationMessageV3') {
      const pollName = result.name || 'Enquete';
      const options = result.options || [];
      const maxSelections = result.selectableOptionsCount ?? 1; // Use ?? instead of || to handle 0

      let formattedPoll = `📊 *Enquete: ${pollName}*\n\n`;
      formattedPoll += `_Opções:_\n`;

      options.forEach((option, index) => {
        formattedPoll += `${index + 1}. ${option.optionName}\n`;
      });

      // Format selection type in a friendly way
      let selectionType = '';
      if (maxSelections === 0) {
        selectionType = 'Múltipla escolha';
      } else if (maxSelections === 1) {
        selectionType = 'Escolha única';
      } else {
        selectionType = `Até ${maxSelections} opções`;
      }

      formattedPoll += `\n_Tipo:_ ${selectionType}\n`;
      formattedPoll += `\n_Esta é uma enquete. Visualize no celular para votar._`;

      return formattedPoll;
    }

    if (typeKey === 'interactiveMessage') {
      try {
        const buttons = result?.nativeFlowMessage?.buttons || result?.buttons || [];

        // Check if it's a payment message (PIX)
        for (const button of buttons) {
          if (button.name === 'payment_info' && button.buttonParamsJson) {
            const params = JSON.parse(button.buttonParamsJson);
            const pixSettings = params.payment_settings?.find((s) => s.type === 'pix_static_code');

            if (pixSettings) {
              const pix = pixSettings.pix_static_code;
              const amount = params.total_amount?.value / 100 || 0;

              // Translate key type to Portuguese
              const keyTypeMap = {
                PHONE: 'Celular',
                CPF: 'CPF',
                CNPJ: 'CNPJ',
                EMAIL: 'E-mail',
                EVP: 'Chave aleatória',
              };
              const keyTypeLabel = keyTypeMap[pix.key_type] || pix.key_type;

              return (
                `💰 *Pagamento PIX*\n\n` +
                `_Valor:_ R$ ${amount.toFixed(2)}\n` +
                `_Beneficiário:_ ${pix.merchant_name}\n` +
                `_Chave PIX (${keyTypeLabel}):_ ${pix.key}\n` +
                `_Referência:_ ${params.reference_id}\n\n` +
                `_Esta é uma solicitação de pagamento. Verifique no celular para pagar._`
              );
            }
          }
        }

        // Generic interactive message
        return '📱 *Mensagem interativa*\n\n_Esta mensagem contém botões ou elementos interativos. Visualize no celular para interagir._';
      } catch {
        return '📱 *Mensagem interativa*\n\n_Esta mensagem contém elementos interativos. Visualize no celular._';
      }
    }

    if (typeKey === 'locationMessage' || typeKey === 'liveLocationMessage') {
      const latitude = result.degreesLatitude;
      const longitude = result.degreesLongitude;

      const locationName = result?.name;
      const locationAddress = result?.address;

      const formattedLocation =
        `*${i18next.t('cw.locationMessage.location')}:*\n\n` +
        `_${i18next.t('cw.locationMessage.latitude')}:_ ${latitude} \n` +
        `_${i18next.t('cw.locationMessage.longitude')}:_ ${longitude} \n` +
        (locationName ? `_${i18next.t('cw.locationMessage.locationName')}:_ ${locationName}\n` : '') +
        (locationAddress ? `_${i18next.t('cw.locationMessage.locationAddress')}:_ ${locationAddress} \n` : '') +
        `_${i18next.t('cw.locationMessage.locationUrl')}:_ ` +
        `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;

      return formattedLocation;
    }

    if (typeKey === 'contactMessage') {
      const vCardData = result.split('\n');
      const contactInfo = {};

      vCardData.forEach((line) => {
        const [key, value] = line.split(':');
        if (key && value) {
          contactInfo[key] = value;
        }
      });

      let formattedContact =
        `*${i18next.t('cw.contactMessage.contact')}:*\n\n` +
        `_${i18next.t('cw.contactMessage.name')}:_ ${contactInfo['FN']}`;

      let numberCount = 1;
      Object.keys(contactInfo).forEach((key) => {
        if (key.startsWith('item') && key.includes('TEL')) {
          const phoneNumber = contactInfo[key];
          formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
          numberCount++;
        } else if (key.includes('TEL')) {
          const phoneNumber = contactInfo[key];
          formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
          numberCount++;
        }
      });

      return formattedContact;
    }

    if (typeKey === 'contactsArrayMessage') {
      const formattedContacts = result.contacts.map((contact) => {
        const vCardData = contact.vcard.split('\n');
        const contactInfo = {};

        vCardData.forEach((line) => {
          const [key, value] = line.split(':');
          if (key && value) {
            contactInfo[key] = value;
          }
        });

        let formattedContact = `*${i18next.t('cw.contactMessage.contact')}:*\n\n_${i18next.t(
          'cw.contactMessage.name',
        )}:_ ${contact.displayName}`;

        let numberCount = 1;
        Object.keys(contactInfo).forEach((key) => {
          if (key.startsWith('item') && key.includes('TEL')) {
            const phoneNumber = contactInfo[key];
            formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
            numberCount++;
          } else if (key.includes('TEL')) {
            const phoneNumber = contactInfo[key];
            formattedContact += `\n_${i18next.t('cw.contactMessage.number')} (${numberCount}):_ ${phoneNumber}`;
            numberCount++;
          }
        });

        return formattedContact;
      });

      const formattedContactsArray = formattedContacts.join('\n\n');

      return formattedContactsArray;
    }

    if (typeKey === 'listMessage') {
      const listTitle = result?.title || 'Unknown';
      const listDescription = result?.description || 'Unknown';
      const listFooter = result?.footerText || 'Unknown';

      let formattedList =
        '*List Menu:*\n\n' +
        '_Title_: ' +
        listTitle +
        '\n' +
        '_Description_: ' +
        listDescription +
        '\n' +
        '_Footer_: ' +
        listFooter;

      if (result.sections && result.sections.length > 0) {
        result.sections.forEach((section, sectionIndex) => {
          formattedList += '\n\n*Section ' + (sectionIndex + 1) + ':* ' + section.title || 'Unknown\n';

          if (section.rows && section.rows.length > 0) {
            section.rows.forEach((row, rowIndex) => {
              formattedList += '\n*Line ' + (rowIndex + 1) + ':*\n';
              formattedList += '_▪️ Title:_ ' + (row.title || 'Unknown') + '\n';
              formattedList += '_▪️ Description:_ ' + (row.description || 'Unknown') + '\n';
              formattedList += '_▪️ ID:_ ' + (row.rowId || 'Unknown') + '\n';
            });
          } else {
            formattedList += '\nNo lines found in this section.\n';
          }
        });
      } else {
        formattedList += '\nNo sections found.\n';
      }

      return formattedList;
    }

    if (typeKey === 'listResponseMessage') {
      const responseTitle = result?.title || 'Unknown';
      const responseDescription = result?.description || 'Unknown';
      const responseRowId = result?.singleSelectReply?.selectedRowId || 'Unknown';

      const formattedResponseList =
        '*List Response:*\n\n' +
        '_Title_: ' +
        responseTitle +
        '\n' +
        '_Description_: ' +
        responseDescription +
        '\n' +
        '_ID_: ' +
        responseRowId;
      return formattedResponseList;
    }

    // Log de warning se nenhum tipo foi encontrado (para debug)
    if (!typeKey) {
      // Mostra quais tipos tem valor (não undefined)
      const typesWithValue = Object.keys(types)
        .filter((key) => types[key] !== undefined)
        .map((key) => `${key}: ${typeof types[key]}`);

      this.logger.warn(
        `⚠️ getMessageContent: Nenhum tipo de mensagem encontrado - Keys: ${JSON.stringify(Object.keys(types))}`,
      );
      this.logger.warn(
        `⚠️ getMessageContent: Tipos com valor: ${typesWithValue.length > 0 ? JSON.stringify(typesWithValue) : 'NENHUM'}`,
      );
      this.logger.warn(`⚠️ getMessageContent: Estrutura completa: ${JSON.stringify(types, null, 2)}`);
    }

    return result;
  }

  public getConversationMessage(msg: any, fullMessage?: any) {
    const types = this.getTypeMessage(msg);

    let messageContent = this.getMessageContent(types);

    // ✅ Adiciona indicador de mensagem encaminhada
    const isForwarded = fullMessage?.isForwarded || msg?.isForwarded;
    const forwardingScore = fullMessage?.forwardingScore || msg?.forwardingScore;

    if (isForwarded) {
      const forwardCount = forwardingScore || 1;
      const forwardIndicator = forwardCount > 1 ? `↪️ _Encaminhada ${forwardCount}x_\n\n` : `↪️ _Encaminhada_\n\n`;

      this.logger.verbose(
        `✅ Mensagem encaminhada detectada - Score: ${forwardingScore} | Count: ${forwardCount} | Indicador: "${forwardIndicator.trim()}"`,
      );

      // 🔧 FIX: Só adiciona indicador se messageContent existir (evita "undefined" em mídias sem caption)
      if (messageContent) {
        messageContent = forwardIndicator + messageContent;
      } else {
        messageContent = forwardIndicator.trim(); // Remove \n\n do final quando não tem conteúdo
      }
    }

    return messageContent;
  }

  /**
   * Extrai conteúdo de texto da mensagem para deduplicação
   */
  private extractMessageContent(body: any): string | null {
    return (
      body.message?.conversation ||
      body.message?.extendedTextMessage?.text ||
      body.message?.imageMessage?.caption ||
      body.message?.videoMessage?.caption ||
      body.message?.documentMessage?.caption ||
      null
    );
  }

  /**
   * Normaliza o JID para deduplicação (sempre usa número real quando disponível)
   */
  private normalizeJidForDedup(body: any): string {
    const remoteJid = body.key?.remoteJid;
    const remoteJidAlt = body.key?.remoteJidAlt;

    // Se tem remoteJidAlt e NÃO é LID, usa ele (é o número real)
    if (remoteJidAlt && !remoteJidAlt.includes('@lid')) {
      return remoteJidAlt;
    }

    // Se remoteJid NÃO é LID, usa ele
    if (remoteJid && !remoteJid.includes('@lid')) {
      return remoteJid;
    }

    // Se ambos são LID ou só tem um, usa o remoteJid
    return remoteJid || remoteJidAlt || 'unknown';
  }

  /**
   * Marca mensagem como processada no cache de deduplicação
   */
  private markMessageAsProcessed(instance: InstanceDto, body: any): void {
    if (!body?.key?.id) return;

    const messageId = `${instance.instanceName}_${body.key.id}`;
    const messageContent = this.extractMessageContent(body);
    const normalizedJid = this.normalizeJidForDedup(body);

    messageDeduplicationCache.markAsProcessed(messageId, normalizedJid, messageContent);
    this.logger.verbose(`✅ Mensagem marcada como processada: ${body.key.id} | JID normalizado: ${normalizedJid}`);
  }

  public async eventWhatsapp(event: string, instance: InstanceDto, body: any) {
    try {
      // ✅ Anti-duplicata: Verifica se mensagem já foi processada
      if (event === Events.MESSAGES_UPSERT && body?.key?.id) {
        const messageId = `${instance.instanceName}_${body.key.id}`;

        // Verifica duplicata por ID
        if (messageDeduplicationCache.isDuplicate(messageId)) {
          this.logger.verbose(`Mensagem duplicada ignorada por ID: ${body.key.id}`);
          return null;
        }

        // ✅ Verifica duplicata por CONTEÚDO (para casos onde Baileys envia IDs diferentes)
        const messageContent = this.extractMessageContent(body);
        const messageTimestamp = body.messageTimestamp ? body.messageTimestamp * 1000 : Date.now();
        const normalizedJid = this.normalizeJidForDedup(body);

        if (messageContent && normalizedJid) {
          // Verifica se e duplicata (em processamento OU ja processada)
          if (messageDeduplicationCache.isDuplicateByContent(normalizedJid, messageContent, messageTimestamp)) {
            this.logger.warn(
              `⚠️ Mensagem duplicada ignorada por CONTEUDO: ${body.key.id} | JID normalizado: ${normalizedJid}`,
            );
            return null;
          }

          // 🔒 Marca como "em processamento" IMEDIATAMENTE para prevenir race condition
          // Se outra mensagem identica chegar no mesmo segundo, sera bloqueada
          messageDeduplicationCache.markAsProcessing(normalizedJid, messageContent, messageTimestamp);
        }

        // ⚠️ NÃO marca como processado aqui! Só marca após processar com sucesso
        // Isso permite retry em caso de erro e previne perda de mensagens
      }

      const waInstance = this.waMonitor.waInstances[instance.instanceName];

      if (!waInstance) {
        this.logger.warn('wa instance not found');
        return null;
      }

      // 🔧 Seta o provider no contexto ANTES de qualquer operação
      // Isso garante que createBotMessage funcione em TODOS os eventos (qrcode, commands, etc)
      this.provider = await waInstance.findChatwoot();

      const client = await this.clientCw(instance);

      if (!client) {
        this.logger.warn('client not found');
        return null;
      }

      if (this.provider?.ignoreJids && this.provider?.ignoreJids.length > 0) {
        const ignoreJids: any = this.provider?.ignoreJids;

        let ignoreGroups = false;
        let ignoreContacts = false;

        if (ignoreJids.includes('@g.us')) {
          ignoreGroups = true;
        }

        if (ignoreJids.includes('@s.whatsapp.net')) {
          ignoreContacts = true;
        }

        if (ignoreGroups && body?.key?.remoteJid.endsWith('@g.us')) {
          this.logger.warn('Ignoring message from group: ' + body?.key?.remoteJid);
          return;
        }

        if (ignoreContacts && body?.key?.remoteJid.endsWith('@s.whatsapp.net')) {
          this.logger.warn('Ignoring message from contact: ' + body?.key?.remoteJid);
          return;
        }

        if (ignoreJids.includes(body?.key?.remoteJid)) {
          this.logger.warn('Ignoring message from jid: ' + body?.key?.remoteJid);
          return;
        }
      }

      if (event === 'messages.upsert' || event === 'send.message') {
        // ⏱️ Marca tempo de início do processamento
        const startTime = Date.now();
        const messageTimestamp = body.messageTimestamp ? body.messageTimestamp * 1000 : Date.now();
        const receiveDelay = startTime - messageTimestamp;

        this.logger.log(
          `⏱️ [PERF] Mensagem recebida - ID: ${body.key.id} | Delay recebimento: ${receiveDelay}ms | Timestamp msg: ${new Date(messageTimestamp).toISOString()}`,
        );
        this.logger.info(`[${event}] New message received - Instance: ${JSON.stringify(body, null, 2)}`);
        if (body.key.remoteJid === 'status@broadcast') {
          return;
        }

        // 🔧 FIX: Processa protocolMessage de edição diretamente se o evento messages.edit não vier
        if (body.message?.protocolMessage) {
          const protocolType = body.message.protocolMessage.type;

          this.logger.verbose(
            `[messages.upsert] protocolMessage detectado - Type: ${protocolType} | Key: ${body.key.id}`,
          );

          // Se for edição (type 14 = MESSAGE_EDIT), processa aqui como fallback
          if (protocolType === 14) {
            const editedMessageContentRaw =
              body.message.protocolMessage.editedMessage?.conversation ??
              body.message.protocolMessage.editedMessage?.extendedTextMessage?.text ??
              body.message.protocolMessage.editedMessage?.imageMessage?.caption ??
              body.message.protocolMessage.editedMessage?.videoMessage?.caption ??
              body.message.protocolMessage.editedMessage?.documentMessage?.caption;

            const editedMessageContent = (editedMessageContentRaw ?? '').trim();

            if (editedMessageContent) {
              this.logger.info(
                `[messages.upsert] Processando edição via protocolMessage (fallback) - Content: ${editedMessageContent}`,
              );

              const message = await this.getMessageByKeyId(instance, body.message.protocolMessage.key.id);
              if (message && message.chatwootConversationId) {
                const key = message.key as WAMessageKey;
                const messageType = key?.fromMe ? 'outgoing' : 'incoming';
                const label = `\`${i18next.t('cw.message.edited')}:\``;
                const editedText = `${label} ${editedMessageContent}`;

                await this.createMessage(
                  instance,
                  message.chatwootConversationId,
                  editedText,
                  messageType,
                  false,
                  [],
                  { message: { extendedTextMessage: { contextInfo: { stanzaId: key.id } } } },
                  'WAID:' + body.message.protocolMessage.key.id,
                  null,
                );

                this.logger.info('[messages.upsert] Edição processada com sucesso via protocolMessage');
              }
            }
          }

          // Ignora o protocolMessage após processar (se necessário)
          return;
        }

        if (body.message?.ephemeralMessage?.message) {
          body.message = {
            ...body.message?.ephemeralMessage?.message,
          };
        }

        const originalMessage = await this.getConversationMessage(body.message, body);

        const bodyMessage = originalMessage
          ? originalMessage
              .replaceAll(/\*((?!\s)([^\n*]+?)(?<!\s))\*/g, '**$1**')
              .replaceAll(/_((?!\s)([^\n_]+?)(?<!\s))_/g, '*$1*')
              .replaceAll(/~((?!\s)([^\n~]+?)(?<!\s))~/g, '~~$1~~')
          : originalMessage;

        if (bodyMessage && bodyMessage.includes('/survey/responses/') && bodyMessage.includes('http')) {
          return;
        }

        const quotedId = body.contextInfo?.stanzaId || body.message?.contextInfo?.stanzaId;

        let quotedMsg = null;

        if (quotedId)
          quotedMsg = await this.prismaRepository.message.findFirst({
            where: {
              key: {
                path: ['id'],
                equals: quotedId,
              },
              chatwootMessageId: {
                not: null,
              },
            },
          });

        const isMedia = this.isMediaMessage(body.message);

        const adsMessage = this.getAdsMessage(body);

        const reactionMessage = this.getReactionMessage(body.message);
        const isInteractiveButtonMessage = this.isInteractiveButtonMessage(body.messageType, body.message);

        if (!bodyMessage && !isMedia && !reactionMessage && !isInteractiveButtonMessage) {
          this.logger.warn('no body message found');
          return;
        }

        const getConversation = await this.createConversation(instance, body);

        const conversationTime = Date.now();
        this.logger.log(
          `⏱️ [PERF] Conversa criada/encontrada - ID: ${body.key.id} | Tempo: ${conversationTime - startTime}ms`,
        );

        if (!getConversation) {
          this.logger.warn(
            `conversation not found - remoteJid: ${body.key.remoteJid}, addressingMode: ${body.key.addressingMode}, remoteJidAlt: ${body.key.remoteJidAlt}`,
          );
          return;
        }

        const messageType = body.key.fromMe ? 'outgoing' : 'incoming';

        if (isMedia) {
          const downloadBase64 = await waInstance?.getBase64FromMediaMessage({
            message: {
              ...body,
            },
          });

          let nameFile: string;
          const messageBody = body?.message[body?.messageType];
          const originalFilename =
            messageBody?.fileName || messageBody?.filename || messageBody?.message?.documentMessage?.fileName;
          if (originalFilename) {
            const parsedFile = path.parse(originalFilename);
            if (parsedFile.name && parsedFile.ext) {
              nameFile = `${parsedFile.name}-${Math.floor(Math.random() * (99 - 10 + 1) + 10)}${parsedFile.ext}`;
            }
          }

          if (!nameFile) {
            nameFile = `${Math.random().toString(36).substring(7)}.${mimeTypes.extension(downloadBase64.mimetype) || ''}`;
          }

          const fileData = Buffer.from(downloadBase64.base64, 'base64');

          const fileStream = new Readable();
          fileStream._read = () => {};
          fileStream.push(fileData);
          fileStream.push(null);

          if (body.key.remoteJid.includes('@g.us')) {
            const participantName = body.pushName;

            // Pega o participante correto, preferindo participantAlt se disponível e não for LID
            let participantJid = body.key.participant;
            if (body.key.addressingMode === 'lid' && !body.key.fromMe && body.key.participantAlt) {
              // Se participantAlt não contém @lid, usa ele (é o número real)
              if (!body.key.participantAlt.includes('@lid')) {
                participantJid = body.key.participantAlt;
              }
            }

            const rawPhoneNumber = participantJid.split('@')[0].split(':')[0];
            const formattedPhoneNumber = parsePhoneNumberFromString(`+${rawPhoneNumber}`).formatInternational();

            let content: string;

            if (!body.key.fromMe) {
              content = bodyMessage
                ? `**${formattedPhoneNumber} - ${participantName}:**\n\n${bodyMessage}`
                : `**${formattedPhoneNumber} - ${participantName}:**`;
            } else {
              content = bodyMessage || '';
            }

            const send = await this.sendData(
              getConversation,
              fileStream,
              nameFile,
              messageType,
              content,
              instance,
              body,
              'WAID:' + body.key.id,
              quotedMsg,
            );

            const sendTime = Date.now();
            const totalTime = sendTime - startTime;
            this.logger.log(
              `⏱️ [PERF] Mensagem MIDIA enviada ao Chatwoot - ID: ${body.key.id} | Tempo envio: ${sendTime - conversationTime}ms | Tempo total: ${totalTime}ms`,
            );

            if (!send) {
              this.logger.warn('message not sent');
              return;
            }

            // ✅ Marca como processada SOMENTE após sucesso
            if (body?.key?.id) {
              const messageId = `${instance.instanceName}_${body.key.id}`;
              messageDeduplicationCache.markAsProcessed(messageId);
              this.logger.verbose(`✅ Mensagem marcada como processada: ${body.key.id}`);
            }

            return send;
          } else {
            const send = await this.sendData(
              getConversation,
              fileStream,
              nameFile,
              messageType,
              bodyMessage,
              instance,
              body,
              'WAID:' + body.key.id,
              quotedMsg,
            );

            const sendTime = Date.now();
            const totalTime = sendTime - startTime;
            this.logger.log(
              `⏱️ [PERF] Mensagem MIDIA enviada ao Chatwoot - ID: ${body.key.id} | Tempo envio: ${sendTime - conversationTime}ms | Tempo total: ${totalTime}ms`,
            );

            if (!send) {
              this.logger.warn('message not sent');
              return;
            }

            // ✅ Marca como processada SOMENTE após sucesso
            if (body?.key?.id) {
              const messageId = `${instance.instanceName}_${body.key.id}`;
              messageDeduplicationCache.markAsProcessed(messageId);
              this.logger.verbose(`✅ Mensagem marcada como processada: ${body.key.id}`);
            }

            return send;
          }
        }

        if (reactionMessage) {
          if (reactionMessage.text) {
            // Format reaction message with sender name
            const isGroup = body.key.remoteJid.includes('@g.us');
            const senderName = body.pushName || 'Unknown';
            const reactionText = isGroup
              ? `${senderName} reagiu: ${reactionMessage.text}`
              : `Reagiu: ${reactionMessage.text}`;

            // Get the original message that was reacted to (com retry para race condition)
            let reactedToMsg = null;
            let retryCount = 0;
            const maxRetries = 3;

            while (!reactedToMsg && retryCount < maxRetries) {
              reactedToMsg = await this.prismaRepository.message.findFirst({
                where: {
                  key: {
                    path: ['id'],
                    equals: reactionMessage.key.id,
                  },
                  instanceId: instance.instanceId,
                },
              });

              if (!reactedToMsg && retryCount < maxRetries - 1) {
                this.logger.verbose(
                  `[REACTION] Mensagem original não encontrada ainda, aguardando... (tentativa ${retryCount + 1}/${maxRetries})`,
                );
                await new Promise((resolve) => setTimeout(resolve, 500)); // Aguarda 500ms
                retryCount++;
              } else {
                break;
              }
            }

            // Log para diagnóstico
            if (!reactedToMsg) {
              this.logger.warn(
                `[REACTION] Mensagem original não encontrada após ${maxRetries} tentativas. Key ID: ${reactionMessage.key.id}`,
              );
            } else if (!reactedToMsg.chatwootMessageId) {
              this.logger.warn(
                `[REACTION] Mensagem original encontrada mas sem chatwootMessageId. Key ID: ${reactionMessage.key.id}, Message ID: ${reactedToMsg.id}`,
              );
            } else {
              this.logger.verbose(
                `[REACTION] Vinculando reação à mensagem Chatwoot ID: ${reactedToMsg.chatwootMessageId}`,
              );
            }

            const send = await this.createMessage(
              instance,
              getConversation,
              reactionText,
              messageType,
              false,
              [],
              {
                message: { extendedTextMessage: { contextInfo: { stanzaId: reactionMessage.key.id } } },
              },
              'WAID:' + body.key.id,
              reactedToMsg,
            );
            if (!send) {
              this.logger.warn('message not sent');
              return;
            }

            // ✅ Marca como processada SOMENTE após sucesso
            if (body?.key?.id) {
              const messageId = `${instance.instanceName}_${body.key.id}`;
              messageDeduplicationCache.markAsProcessed(messageId);
              this.logger.verbose(`✅ Mensagem marcada como processada: ${body.key.id}`);
            }
          }

          return;
        }

        if (isInteractiveButtonMessage) {
          const buttons = body.message.interactiveMessage.nativeFlowMessage.buttons;
          this.logger.info('is Interactive Button Message: ' + JSON.stringify(buttons));

          for (const button of buttons) {
            const buttonParams = JSON.parse(button.buttonParamsJson);
            const paymentSettings = buttonParams.payment_settings;

            if (button.name === 'payment_info' && paymentSettings[0].type === 'pix_static_code') {
              const pixSettings = paymentSettings[0].pix_static_code;
              const pixKeyType = (() => {
                switch (pixSettings.key_type) {
                  case 'EVP':
                    return 'Chave Aleatória';
                  case 'EMAIL':
                    return 'E-mail';
                  case 'PHONE':
                    return 'Telefone';
                  default:
                    return pixSettings.key_type;
                }
              })();
              const pixKey = pixSettings.key_type === 'PHONE' ? pixSettings.key.replace('+55', '') : pixSettings.key;
              const content = `*${pixSettings.merchant_name}*\nChave PIX: ${pixKey} (${pixKeyType})`;

              const send = await this.createMessage(
                instance,
                getConversation,
                content,
                messageType,
                false,
                [],
                body,
                'WAID:' + body.key.id,
                quotedMsg,
              );
              if (!send) this.logger.warn('message not sent');
            } else {
              this.logger.warn('Interactive Button Message not mapped');
            }
          }
          return;
        }

        const isAdsMessage = (adsMessage && adsMessage.title) || adsMessage.body || adsMessage.thumbnailUrl;
        if (isAdsMessage) {
          const imgBuffer = await axios.get(adsMessage.thumbnailUrl, { responseType: 'arraybuffer' });

          const extension = mimeTypes.extension(imgBuffer.headers['content-type']);
          const lookedUpMimeType = extension && mimeTypes.lookup(extension);
          const mimeType = lookedUpMimeType ? lookedUpMimeType.toString() : '';

          if (!mimeType) {
            this.logger.warn('mimetype of Ads message not found');
            return;
          }

          const random = Math.random().toString(36).substring(7);
          const fileExtension = mimeTypes.extension(mimeType) || 'bin';
          const nameFile = `${random}.${fileExtension}`;
          const fileData = Buffer.from(imgBuffer.data, 'binary');

          const img = await Jimp.read(fileData);
          await img.cover({
            w: 320,
            h: 180,
          });
          const processedBuffer = await img.getBuffer(JimpMime.png);

          const fileStream = new Readable();
          fileStream._read = () => {}; // _read is required but you can noop it
          fileStream.push(processedBuffer);
          fileStream.push(null);

          const truncStr = (str: string, len: number) => {
            if (!str) return '';

            return str.length > len ? str.substring(0, len) + '...' : str;
          };

          const title = truncStr(adsMessage.title, 40);
          const description = truncStr(adsMessage?.body, 75);

          const send = await this.sendData(
            getConversation,
            fileStream,
            nameFile,
            messageType,
            `${bodyMessage}\n\n\n**${title}**\n${description}\n${adsMessage.sourceUrl}`,
            instance,
            body,
            'WAID:' + body.key.id,
          );

          if (!send) {
            this.logger.warn('message not sent');
            return;
          }

          // ✅ Marca como processada SOMENTE após sucesso
          if (body?.key?.id) {
            const messageId = `${instance.instanceName}_${body.key.id}`;
            messageDeduplicationCache.markAsProcessed(messageId);
            this.logger.verbose(`✅ Mensagem marcada como processada: ${body.key.id}`);
          }

          return send;
        }

        if (body.key.remoteJid.includes('@g.us')) {
          const participantName = body.pushName;

          // Pega o participante correto, preferindo participantAlt se disponível e não for LID
          let participantJid = body.key.participant;
          if (body.key.addressingMode === 'lid' && !body.key.fromMe && body.key.participantAlt) {
            // Se participantAlt não contém @lid, usa ele (é o número real)
            if (!body.key.participantAlt.includes('@lid')) {
              participantJid = body.key.participantAlt;
            }
          }

          const rawPhoneNumber = participantJid.split('@')[0].split(':')[0];
          const formattedPhoneNumber = parsePhoneNumberFromString(`+${rawPhoneNumber}`).formatInternational();

          let content: string;

          if (!body.key.fromMe) {
            content = `**${formattedPhoneNumber} - ${participantName}:**\n\n${bodyMessage}`;
          } else {
            content = `${bodyMessage}`;
          }

          const send = await this.createMessage(
            instance,
            getConversation,
            content,
            messageType,
            false,
            [],
            body,
            'WAID:' + body.key.id,
            quotedMsg,
          );

          const sendTime = Date.now();
          const totalTime = sendTime - startTime;
          this.logger.log(
            `⏱️ [PERF] Mensagem GRUPO enviada ao Chatwoot - ID: ${body.key.id} | Tempo envio: ${sendTime - conversationTime}ms | Tempo total: ${totalTime}ms`,
          );

          if (!send) {
            this.logger.warn('message not sent');
            return;
          }

          // ✅ Marca como processada SOMENTE após sucesso
          if (body?.key?.id) {
            const messageId = `${instance.instanceName}_${body.key.id}`;
            messageDeduplicationCache.markAsProcessed(messageId);
            this.logger.verbose(`✅ Mensagem marcada como processada: ${body.key.id}`);
          }

          return send;
        } else {
          const send = await this.createMessage(
            instance,
            getConversation,
            bodyMessage,
            messageType,
            false,
            [],
            body,
            'WAID:' + body.key.id,
            quotedMsg,
          );

          const sendTime = Date.now();
          const totalTime = sendTime - startTime;
          this.logger.log(
            `⏱️ [PERF] Mensagem TEXTO enviada ao Chatwoot - ID: ${body.key.id} | Tempo envio: ${sendTime - conversationTime}ms | Tempo total: ${totalTime}ms`,
          );

          if (!send) {
            this.logger.warn('message not sent');
            return;
          }

          // ✅ Marca como processada SOMENTE após sucesso
          if (body?.key?.id) {
            const messageId = `${instance.instanceName}_${body.key.id}`;
            messageDeduplicationCache.markAsProcessed(messageId);
            this.logger.verbose(`✅ Mensagem marcada como processada: ${body.key.id}`);
          }

          return send;
        }
      }
      //  DELETE
      // Hard delete quando habilitado; senão cria placeholder "apagada pelo remetente"
      if (event === Events.MESSAGES_DELETE) {
        // ✅ Anti-duplicata usando DeleteDeduplicationCache (com cleanup automático)
        const dedupKey = `cw_del_${instance.instanceId}_${body?.key?.id}`;

        if (deleteDeduplicationCache.isDuplicate(dedupKey)) {
          this.logger.info(`[CW.DELETE] Ignorado (duplicado local) para ${body?.key?.id}`);
          return;
        }

        deleteDeduplicationCache.markAsProcessed(dedupKey);

        const chatwootDelete = this.configService.get<Chatwoot>('CHATWOOT').MESSAGE_DELETE;

        if (!body?.key?.id) {
          this.logger.warn('message id not found');
          return;
        }

        const message = await this.getMessageByKeyId(instance, body.key.id);
        if (!message) {
          this.logger.warn('Message not found for delete event');
          return;
        }

        if (chatwootDelete === true && message?.chatwootMessageId && message?.chatwootConversationId) {
          await this.prismaRepository.message.deleteMany({
            where: {
              key: { path: ['id'], equals: body.key.id },
              instanceId: instance.instanceId,
            },
          });

          await client.messages.delete({
            accountId: this.provider.accountId,
            conversationId: message.chatwootConversationId,
            messageId: message.chatwootMessageId,
          });
          return; // hard delete
        } else {
          const key = message.key as WAMessageKey;
          const messageType = key?.fromMe ? 'outgoing' : 'incoming';
          const DELETE_PLACEHOLDER = '🗑️ Mensagem apagada pelo remetente';

          if (message.chatwootConversationId) {
            const send = await this.createMessage(
              instance,
              message.chatwootConversationId,
              DELETE_PLACEHOLDER,
              messageType,
              false,
              [],
              { message: { extendedTextMessage: { contextInfo: { stanzaId: key.id } } } },
              'DEL:' + body.key.id, // mantém a intenção de idempotência
              null,
            );
            if (!send) this.logger.warn('delete placeholder not sent');
          }
          return;
        }
      }

      //  EDIT
      // Cria "Mensagem editada: <texto>" SOMENTE se houver texto (evita 'undefined')
      // Se vier "edit" sem texto (REVOKE mascarado), não faz nada aqui — o bloco de DELETE trata.
      if (event === 'messages.edit' || event === 'send.message.update') {
        const editedMessageContentRaw =
          body?.editedMessage?.conversation ??
          body?.editedMessage?.extendedTextMessage?.text ??
          body?.editedMessage?.imageMessage?.caption ??
          body?.editedMessage?.videoMessage?.caption ??
          body?.editedMessage?.documentMessage?.caption ??
          (typeof body?.text === 'string' ? body.text : undefined);

        const editedMessageContent = (editedMessageContentRaw ?? '').trim();

        // Sem conteúdo? Ignora aqui. O DELETE vai gerar o placeholder se for o caso.
        if (!editedMessageContent) {
          this.logger.info('[CW.EDIT] Conteúdo vazio — ignorando (DELETE tratará se for revoke).');
          return;
        }

        const message = await this.getMessageByKeyId(instance, body?.key?.id);
        if (!message) {
          this.logger.warn('Message not found for edit event');
          return;
        }

        const key = message.key as WAMessageKey;
        const messageType = key?.fromMe ? 'outgoing' : 'incoming';

        if (message.chatwootConversationId) {
          const label = `\`${i18next.t('cw.message.edited')}:\``; // "Mensagem editada:"
          const editedText = `${label} ${editedMessageContent}`;
          const send = await this.createMessage(
            instance,
            message.chatwootConversationId,
            editedText,
            messageType,
            false,
            [],
            { message: { extendedTextMessage: { contextInfo: { stanzaId: key.id } } } },
            'WAID:' + body.key.id,
            null,
          );
          if (!send) this.logger.warn('edited message not sent');
        }
        return;
      }

      // FIM DA EDIÇÃO

      if (event === 'messages.read') {
        if (!body?.key?.id || !body?.key?.remoteJid) {
          this.logger.warn('message id not found');
          return;
        }

        const message = await this.getMessageByKeyId(instance, body.key.id);
        const conversationId = message?.chatwootConversationId;
        const contactInboxSourceId = message?.chatwootContactInboxSourceId;

        if (conversationId) {
          let sourceId = contactInboxSourceId;
          const inbox = (await this.getInbox(instance)) as inbox & {
            inbox_identifier?: string;
          };

          if (!sourceId && inbox) {
            const conversation = (await client.conversations.get({
              accountId: this.provider.accountId,
              conversationId: conversationId,
            })) as conversation_show & {
              last_non_activity_message: { conversation: { contact_inbox: contact_inboxes } };
            };
            sourceId = conversation.last_non_activity_message?.conversation?.contact_inbox?.source_id;
          }

          if (sourceId && inbox?.inbox_identifier) {
            const url =
              `/public/api/v1/inboxes/${inbox.inbox_identifier}/contacts/${sourceId}` +
              `/conversations/${conversationId}/update_last_seen`;
            await chatwootRequest(this.getClientCwConfig(), {
              method: 'POST',
              url: url,
            });
          }
        }
        return;
      }

      if (event === 'status.instance') {
        const data = body;
        const inbox = await this.getInbox(instance);

        if (!inbox) {
          this.logger.warn('inbox not found');
          return;
        }

        const msgStatus = i18next.t('cw.inbox.status', {
          inboxName: inbox.name,
          state: data.status,
        });

        await this.createBotMessage(instance, msgStatus, 'incoming');
      }

      if (event === 'connection.update' && body.status === 'open') {
        const waInstance = this.waMonitor.waInstances[instance.instanceName];
        if (!waInstance) return;

        const now = Date.now();
        const timeSinceLastNotification = now - (waInstance.lastConnectionNotification || 0);

        // Se a conexão foi estabelecida via QR code, notifica imediatamente.
        if (waInstance.qrCode && waInstance.qrCode.count > 0) {
          const msgConnection = i18next.t('cw.inbox.connected');
          await this.createBotMessage(instance, msgConnection, 'incoming');
          waInstance.qrCode.count = 0;
          waInstance.lastConnectionNotification = now;
          chatwootImport.clearAll(instance);
        }
        // Se não foi via QR code, verifica o throttling.
        else if (timeSinceLastNotification >= 30000) {
          const msgConnection = i18next.t('cw.inbox.connected');
          await this.createBotMessage(instance, msgConnection, 'incoming');
          waInstance.lastConnectionNotification = now;
        } else {
          this.logger.warn(
            `Connection notification skipped for ${instance.instanceName} - too frequent (${timeSinceLastNotification}ms since last)`,
          );
        }
      }

      if (event === 'qrcode.updated') {
        if (body.statusCode === 500) {
          const erroQRcode = `🚨 ${i18next.t('qrlimitreached')}`;
          return await this.createBotMessage(instance, erroQRcode, 'incoming');
        } else {
          const fileData = Buffer.from(body?.qrcode.base64.replace('data:image/png;base64,', ''), 'base64');

          const fileStream = new Readable();
          fileStream._read = () => {};
          fileStream.push(fileData);
          fileStream.push(null);

          await this.createBotQr(
            instance,
            i18next.t('qrgeneratedsuccesfully'),
            'incoming',
            fileStream,
            `${instance.instanceName}.png`,
          );

          let msgQrCode = `⚡️${i18next.t('qrgeneratedsuccesfully')}\n\n${i18next.t('scanqr')}`;

          if (body?.qrcode?.pairingCode) {
            msgQrCode =
              msgQrCode +
              `\n\n*Pairing Code:* ${body.qrcode.pairingCode.substring(0, 4)}-${body.qrcode.pairingCode.substring(
                4,
                8,
              )}`;
          }

          await this.createBotMessage(instance, msgQrCode, 'incoming');
        }
      }

      // 📸 CONTACTS_UPDATE - Atualiza foto de perfil quando contato muda
      if (event === Events.CONTACTS_UPDATE) {
        this.logger.log(`📸 Evento CONTACTS_UPDATE recebido para ${instance.instanceName}`);
        this.logger.log(`📸 Body completo: ${JSON.stringify(body, null, 2)}`);

        // body pode ser um objeto único ou array
        const contacts = Array.isArray(body) ? body : [body];

        for (const contactData of contacts) {
          try {
            const remoteJid = contactData.remoteJid;
            const profilePicUrl = contactData.profilePicUrl;

            this.logger.log(`📸 Processando contato: ${remoteJid} | Foto: ${profilePicUrl}`);

            if (!remoteJid || !profilePicUrl) {
              this.logger.warn(`⚠️ Contato sem foto ou JID invalido: ${remoteJid}`);
              continue;
            }

            // Busca o contato no Chatwoot
            const chatId = remoteJid.split('@')[0].split(':')[0];
            this.logger.log(`📸 Buscando contato ${chatId} no Chatwoot...`);
            const contact = await this.findContact(instance, chatId);

            if (contact) {
              this.logger.log(`📸 Contato encontrado! ID: ${contact.id} | Nome: ${contact.name}`);
              this.logger.log(`📸 Atualizando foto do contato ${chatId} no Chatwoot com URL: ${profilePicUrl}`);

              await this.updateContact(instance, contact.id, {
                avatar_url: profilePicUrl,
              });

              this.logger.log(`✅ Foto atualizada com sucesso para ${chatId}`);
            } else {
              this.logger.warn(`⚠️ Contato ${chatId} nao encontrado no Chatwoot`);
            }
          } catch (error) {
            this.logger.error(`❌ Erro ao atualizar foto do contato: ${error.message}`);
            this.logger.error(`Stack: ${error.stack}`);
          }
        }
        return;
      }
    } catch (error) {
      const errorMsg = error?.message || String(error);
      const messageId = body?.key?.id || 'unknown';

      this.logger.error(`❌ Erro ao processar evento ${event} (messageId: ${messageId}): ${errorMsg}`);

      if (error?.response?.data) {
        this.logger.error(`Resposta da API Chatwoot: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  public normalizeJidIdentifier(remoteJid: string) {
    if (!remoteJid) {
      return '';
    }
    if (remoteJid.includes('@lid')) {
      return remoteJid;
    }
    return remoteJid.replace(/:\d+/, '').split('@')[0];
  }

  public startImportHistoryMessages(instance: InstanceDto) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    this.createBotMessage(instance, i18next.t('cw.import.startImport'), 'incoming');
  }

  public isImportHistoryAvailable() {
    const uri = this.configService.get<Chatwoot>('CHATWOOT').IMPORT.DATABASE.CONNECTION.URI;

    return uri && uri !== 'postgres://user:password@hostname:port/dbname';
  }

  public addHistoryMessages(instance: InstanceDto, messagesRaw: MessageModel[]) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    chatwootImport.addHistoryMessages(instance, messagesRaw);
  }

  public addHistoryContacts(instance: InstanceDto, contactsRaw: ContactModel[]) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    return chatwootImport.addHistoryContacts(instance, contactsRaw);
  }

  public async importHistoryMessages(instance: InstanceDto) {
    if (!this.isImportHistoryAvailable()) {
      return;
    }

    this.createBotMessage(instance, i18next.t('cw.import.importingMessages'), 'incoming');

    const totalMessagesImported = await chatwootImport.importHistoryMessages(
      instance,
      this,
      await this.getInbox(instance),
      this.provider,
      true, // 🔧 Mostra mensagens do bot ao conectar (QR Code)
      this.prismaRepository, // 🔧 Para converter LIDs
    );
    this.updateContactAvatarInRecentConversations(instance);

    const msg = Number.isInteger(totalMessagesImported)
      ? i18next.t('cw.import.messagesImported', { totalMessagesImported })
      : i18next.t('cw.import.messagesException');

    this.createBotMessage(instance, msg, 'incoming');

    return totalMessagesImported;
  }

  public async updateContactAvatarInRecentConversations(instance: InstanceDto, limitContacts = 100) {
    try {
      if (!this.isImportHistoryAvailable()) {
        return;
      }

      const client = await this.clientCw(instance);
      if (!client) {
        this.logger.warn('client not found');
        return null;
      }

      const inbox = await this.getInbox(instance);
      if (!inbox) {
        this.logger.warn('inbox not found');
        return null;
      }

      const recentContacts = await chatwootImport.getContactsOrderByRecentConversations(
        inbox,
        this.provider,
        limitContacts,
      );

      const contactIdentifiers = recentContacts
        .map((contact) => contact.identifier)
        .filter((identifier) => identifier !== null);

      const contactsWithProfilePicture = (
        await this.prismaRepository.contact.findMany({
          where: {
            instanceId: instance.instanceId,
            id: {
              in: contactIdentifiers,
            },
            profilePicUrl: {
              not: null,
            },
          },
        })
      ).reduce((acc: Map<string, ContactModel>, contact: ContactModel) => acc.set(contact.id, contact), new Map());

      recentContacts.forEach(async (contact) => {
        if (contactsWithProfilePicture.has(contact.identifier)) {
          client.contacts.update({
            accountId: this.provider.accountId,
            id: contact.id,
            data: {
              avatar_url: contactsWithProfilePicture.get(contact.identifier).profilePictureUrl || null,
            },
          });
        }
      });
    } catch (error) {
      this.logger.error(`Error on update avatar in recent conversations: ${error.toString()}`);
    }
  }

  public async syncLostMessages(
    instance: InstanceDto,
    chatwootConfig: ChatwootDto,
    prepareMessage: (message: any) => any,
  ) {
    try {
      this.logger.log(`[syncLostMessages] Iniciando sincronização para ${instance.instanceName}`);

      if (!this.isImportHistoryAvailable()) {
        this.logger.warn('[syncLostMessages] Import history not available');
        return 0;
      }
      if (!this.configService.get<Database>('DATABASE').SAVE_DATA.MESSAGE_UPDATE) {
        this.logger.warn('[syncLostMessages] MESSAGE_UPDATE not enabled');
        return 0;
      }

      // 🔧 Usa o chatwootConfig que já foi passado como parâmetro
      if (!chatwootConfig) {
        this.logger.error(`[syncLostMessages] chatwootConfig not provided for ${instance.instanceName}`);
        throw new Error('Configuração do SoConnect não encontrada. Verifique a integração.');
      }

      // 🔧 Seta o provider no contexto para que getInbox funcione
      this.provider = chatwootConfig;

      const inbox = await this.getInbox(instance);
      if (!inbox) {
        this.logger.error(`[syncLostMessages] Inbox not found for ${instance.instanceName}`);
        throw new Error('Caixa de entrada não encontrada no SoConnect. Verifique a configuração.');
      }

      this.logger.log(`[syncLostMessages] Provider e Inbox validados com sucesso`);
      this.logger.log(`[syncLostMessages] AccountId: ${chatwootConfig.accountId}, InboxId: ${inbox.id}`);

      const sqlMessages = `select * from messages m
      where account_id = ${chatwootConfig.accountId}
      and inbox_id = ${inbox.id}
      and created_at >= now() - interval '10h'
      order by created_at desc`;

      const messagesData = (await this.pgClient.query(sqlMessages))?.rows;
      const ids: string[] = messagesData
        .filter((message) => !!message.source_id)
        .map((message) => message.source_id.replace('WAID:', ''));

      const savedMessages = await this.prismaRepository.message.findMany({
        where: {
          Instance: { name: instance.instanceName },
          messageTimestamp: { gte: Number(dayjs().subtract(10, 'hours').unix()) },
          AND: ids.map((id) => ({ key: { path: ['id'], not: id } })),
        },
      });

      const filteredMessages = savedMessages.filter((msg: any) => {
        // Ignora números especiais (grupos, status, etc)
        if (chatwootImport.isIgnorePhoneNumber(msg.key?.remoteJid)) {
          return false;
        }

        // Ignora mensagens de álbum (metadados) - as mídias reais já são importadas via imageMessage/videoMessage
        if (msg.message?.albumMessage || msg.message?.associatedChildMessage) {
          return false;
        }

        return true;
      });

      this.logger.log(`[syncLostMessages] Mensagens encontradas no banco: ${savedMessages.length}`);
      this.logger.log(`[syncLostMessages] Mensagens após filtro: ${filteredMessages.length}`);

      const messagesRaw: any[] = [];
      for (const m of filteredMessages) {
        if (!m.message || !m.key || !m.messageTimestamp) {
          continue;
        }

        if (Long.isLong(m?.messageTimestamp)) {
          m.messageTimestamp = m.messageTimestamp?.toNumber();
        }

        messagesRaw.push(prepareMessage(m as any));
      }

      this.addHistoryMessages(
        instance,
        messagesRaw.filter((msg) => !chatwootImport.isIgnorePhoneNumber(msg.key?.remoteJid)),
      );

      this.logger.log(`[syncLostMessages] Mensagens preparadas para importação: ${messagesRaw.length}`);

      // 🔧 Se não há mensagens para importar, retorna 0 sem chamar importHistoryMessages
      if (messagesRaw.length === 0) {
        this.logger.log(`[syncLostMessages] Nenhuma mensagem para importar`);
        return 0;
      }

      const totalImported = await chatwootImport.importHistoryMessages(
        instance,
        this,
        inbox,
        this.provider,
        false, // 🔧 Não mostra mensagens do bot no cron (silencioso)
        this.prismaRepository, // 🔧 Para converter LIDs
      );
      const waInstance = this.waMonitor.waInstances[instance.instanceName];
      waInstance.clearCacheChatwoot();

      this.logger.log(`[syncLostMessages] Sincronização concluída: ${totalImported} mensagens importadas`);

      // 🔧 Se retornou 0, pode ser erro silencioso ou realmente não tinha mensagens
      if (totalImported === 0 && messagesRaw.length > 0) {
        this.logger.warn(
          `[syncLostMessages] ⚠️ ATENÇÃO: ${messagesRaw.length} mensagens foram encontradas mas 0 foram importadas. Pode haver erro na importação.`,
        );
      }

      return totalImported || 0;
    } catch (error) {
      this.logger.error(`[syncLostMessages] Erro: ${error.message}`);
      throw error; // Lança erro para o comando /lost tratar
    }
  }
}
