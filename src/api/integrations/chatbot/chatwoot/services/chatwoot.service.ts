import { InstanceDto } from '@api/dto/instance.dto';
import { Options, Quoted, SendAudioDto, SendMediaDto, SendTextDto } from '@api/dto/sendMessage.dto';
import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
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
 * Helper simples para retry com exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 5,
  operationName: string = 'Operação',
  baseDelayMs: number = 3000,
): Promise<T | null> {
  const logger = new Logger('RetryHelper');
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      
      if (attempt > 1) {
        logger.log(`✅ ${operationName} bem-sucedida na tentativa ${attempt}/${maxAttempts}`);
      }
      
      return result;
    } catch (error) {
      const errorMsg = error?.message || String(error);
      
      if (attempt === maxAttempts) {
        logger.error(`❌ ${operationName} falhou após ${maxAttempts} tentativas: ${errorMsg}`);
        return null;
      }
      
      // Exponential backoff: 3s, 6s, 12s, 24s...
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      
      logger.warn(
        `⚠️ ${operationName} falhou (tentativa ${attempt}/${maxAttempts}): ${errorMsg}. ` +
        `Tentando novamente em ${delayMs}ms...`
      );
      
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return null;
}

/**
 * Cache simples para evitar duplicatas de mensagens
 */
class MessageDeduplicationCache {
  private readonly logger = new Logger('MessageDeduplication');
  private cache: Map<string, number> = new Map(); // messageId -> timestamp
  private readonly TTL_MS = 300000; // 5 minutos

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
    
    this.logger.verbose(`Mensagem duplicada detectada: ${messageId}`);
    return true;
  }

  public markAsProcessed(messageId: string): void {
    this.cache.set(messageId, Date.now());
    
    // Limpa cache periodicamente
    if (this.cache.size > 1000) {
      this.cleanup();
    }
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [messageId, timestamp] of this.cache.entries()) {
      if (now - timestamp > this.TTL_MS) {
        this.cache.delete(messageId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.logger.verbose(`Limpeza do cache: ${cleaned} mensagens antigas removidas`);
    }
  }
}

// Singleton para cache de deduplicação
const messageDeduplicationCache = new MessageDeduplicationCache();

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
    // Sistema de retry via syncLostMessages (cron a cada 10min)
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

    if (!isGroup) {
      query = `+${phoneNumber}`;
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
    inboxId: number
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
      const conversations = await client.contacts.listConversations({
        accountId: this.provider.accountId,
        id: contact.id,
      }) as any;

      if (!conversations || !conversations.payload) {
        return null;
      }

      // Busca conversação aberta ou pendente na inbox correta
      const existingConversation = conversations.payload.find(
        (conv: any) => 
          conv.inbox_id === inboxId && 
          (conv.status === 'open' || conv.status === 'pending')
      );

      if (existingConversation) {
        this.logger.verbose(
          `✅ Conversação existente encontrada: ID ${existingConversation.id} (status: ${existingConversation.status})`
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
    
    // 🔧 FIX: Verifica se remoteJid é realmente LID (contém @lid)
    const isLid = remoteJid.includes('@lid');
    
    // Se for LID, usa remoteJidAlt (número normal), senão usa remoteJid
    const phoneNumber = isLid && !isGroup ? body.key.remoteJidAlt : remoteJid;
    
    if (!phoneNumber && !isGroup) {
      this.logger.warn(
        `phoneNumber is null - isLid: ${isLid}, isGroup: ${isGroup}, remoteJid: ${remoteJid}, remoteJidAlt: ${body.key.remoteJidAlt}`,
      );
    }
    
    // 🔧 FIX: Usa phoneNumber como chave para unificar LID e JID normal
    const normalizedKey = isGroup ? remoteJid : (phoneNumber || remoteJid);
    const cacheKey = `${instance.instanceName}:createConversation-${normalizedKey}`;
    const lockKey = `${instance.instanceName}:lock:createConversation-${normalizedKey}`;
    
    this.logger.verbose(`🔑 Normalized key: ${normalizedKey} (isLid: ${isLid}, remoteJid: ${remoteJid})`);
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
              `🔄 Atualizando identifier do contato: ${contact.identifier} → ${phoneNumber} (LID: ${isLid})`
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
                    `✅ Contatos mesclados: (${baseContact.id}) ${baseContact.phone_number} ← (${contact.id}) ${contact.phone_number}`
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
        this.logger.warn(`⏳ Lock já existe para ${remoteJid}, aguardando liberação... (instância: ${instance.instanceName})`);
        const start = Date.now();
        let attempts = 0;
        
        while (await this.cache.has(lockKey)) {
          attempts++;
          const elapsed = Date.now() - start;
          
          if (elapsed > maxWaitTime) {
            this.logger.error(
              `❌ TIMEOUT aguardando lock para ${remoteJid} após ${elapsed}ms (${attempts} tentativas) - ` +
              `Instância: ${instance.instanceName} - Possível deadlock!`
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

        const chatId = isGroup ? remoteJid : phoneNumber?.split('@')[0]?.split(':')[0] || remoteJid.split('@')[0].split(':')[0];
        let nameContact = !body.key.fromMe ? body.pushName : chatId;
        
        // ✅ Retry ao buscar inbox (45 segundos)
        const filterInbox = await retryWithBackoff(
          async () => await this.getInbox(instance),
          5,
          `Buscar inbox no Chatwoot (instance: ${instance.instanceName})`
        );
        
        if (!filterInbox) {
          this.logger.error('Failed to get inbox after retry');
          return null;
        }

        // 🔧 FIX: Verifica se já existe conversação pelo número de telefone (unifica LID e JID)
        if (!isGroup && phoneNumber) {
          const existingConversationId = await this.findExistingConversationByPhone(
            instance,
            phoneNumber,
            filterInbox.id
          );
          
          if (existingConversationId) {
            this.logger.log(
              `✅ Usando conversação existente: ${existingConversationId} (unificando LID/JID para ${chatId})`
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
          if (isLid && !body.key.fromMe && body.key.participantAlt) {
            // Se participantAlt não contém @lid, usa ele (é o número real)
            if (!body.key.participantAlt.includes('@lid')) {
              participantJid = body.key.participantAlt;
            }
          }
          
          nameContact = `${group.subject} (GROUP)`;

          if (!participantJid) {
            this.logger.warn(
              `participantJid is null - group: ${chatId}, isLid: ${isLid}, fromMe: ${body.key.fromMe}, participantAlt: ${body.key.participantAlt}, participant: ${body.key.participant}`,
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
          if (!body.key.fromMe) {
            const waProfilePictureFile =
              picture_url?.profilePictureUrl?.split('#')[0].split('?')[0].split('/').pop() || '';
            const chatwootProfilePictureFile = contact?.thumbnail?.split('#')[0].split('?')[0].split('/').pop() || '';
            const pictureNeedsUpdate = waProfilePictureFile !== chatwootProfilePictureFile;
            const nameNeedsUpdate = !contact.name || contact.name === chatId;
            this.logger.verbose(`Picture needs update: ${pictureNeedsUpdate}`);
            this.logger.verbose(`Name needs update: ${nameNeedsUpdate}`);
            if (pictureNeedsUpdate || nameNeedsUpdate) {
              contact = await this.updateContact(instance, contact.id, {
                ...(nameNeedsUpdate && { name: nameContact }),
                ...(waProfilePictureFile === '' && { avatar: null }),
                ...(pictureNeedsUpdate && { avatar_url: picture_url?.profilePictureUrl }),
              });
            }
          }
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
            return (await client.contacts.listConversations({
              accountId: this.provider.accountId,
              id: contactId,
            })) as any;
          },
          5,
          `Listar conversações do contato no Chatwoot (contactId: ${contactId})`
        );

        if (!contactConversations || !contactConversations.payload) {
          this.logger.error(`No conversations found or payload is undefined`);
          return null;
        }

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
            return await client.conversations.create({
              accountId: this.provider.accountId,
              data,
            });
          },
          5,
          `Criar conversação no Chatwoot (remoteJid: ${remoteJid})`
        );

        // ❌ Se falhou após 45 segundos, será recuperado pelo cron
        if (!conversation) {
          this.logger.warn(`⚠️ Falha ao criar conversação (remoteJid: ${remoteJid}) - será recuperada pelo cron`);
          return null;
        }

        this.logger.verbose(`New conversation created of ${remoteJid} with ID: ${conversation.id}`);
        this.cache.set(cacheKey, conversation.id, 1800);
        return conversation.id;
      } catch (error) {
        this.logger.error(`Error in createConversation: ${error}`);
        
        // ℹ️ Mensagem será recuperada pelo syncLostMessages (cron 10min)
        this.logger.warn(`⚠️ Falha ao criar conversação (remoteJid: ${remoteJid}) - será recuperada pelo cron`);
        
        return null;
      } finally {
        await this.cache.delete(lockKey);
        this.logger.log(`🔓 Lock liberado: ${remoteJid} (instância: ${instance.instanceName})`);
      }
    } catch (error) {
      this.logger.error(`Error in createConversation (outer): ${error}`);
      
      // ℹ️ Mensagem será recuperada pelo syncLostMessages (cron 10min)
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
        return await client.messages.create({
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
      },
      5,
      `Criar mensagem no Chatwoot (conversationId: ${conversationId})`
    );

    // ❌ Se falhou após 45 segundos, será recuperado pelo cron
    if (!message) {
      this.logger.warn(`⚠️ Falha ao enviar mensagem (conversationId: ${conversationId}) - será recuperada pelo cron`);
      return null;
    }

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
        return response.data;
      },
      5,
      `Enviar mídia ao Chatwoot (conversationId: ${conversationId})`
    );

    // ❌ Se falhou após 45 segundos, envia pro RabbitMQ
    if (!result) {
      this.logger.warn(`⚠️ Falha ao enviar mídia (conversationId: ${conversationId}) - será recuperada pelo cron`);
      return null;
    }

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
      const parsedMedia = path.parse(decodeURIComponent(media));
      let mimeType = mimeTypes.lookup(parsedMedia?.ext) || '';
      let fileName = parsedMedia?.name + parsedMedia?.ext;

      if (!mimeType) {
        const parts = media.split('/');
        fileName = decodeURIComponent(parts[parts.length - 1]);

        const response = await axios.get(media, {
          responseType: 'arraybuffer',
        });
        mimeType = response.headers['content-type'];
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

      if (type === 'audio') {
        const data: SendAudioDto = {
          number: number,
          audio: media,
          delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500,
          quoted: options?.quoted,
        };

        sendTelemetry('/message/sendWhatsAppAudio');

        const messageSent = await waInstance?.audioWhatsapp(data, null, true);

        return messageSent;
      }

      const documentExtensions = ['.gif', '.svg', '.tiff', '.tif', '.dxf', '.dwg'];
      if (type === 'image' && parsedMedia && documentExtensions.includes(parsedMedia?.ext)) {
        type = 'document';
      }

      const data: SendMediaDto = {
        number: number,
        mediatype: type as any,
        fileName: fileName,
        media: media,
        delay: 1200,
        quoted: options?.quoted,
      };

      sendTelemetry('/message/sendMedia');

      if (caption) {
        data.caption = caption;
      }

      const messageSent = await waInstance?.mediaMessage(data, null, true);

      return messageSent;
    } catch (error) {
      this.logger.error(error);
      throw error; // Re-throw para que o erro seja tratado pelo caller
    }
  }

  public async onSendMessageError(instance: InstanceDto, conversation: number, error?: any) {
    this.logger.verbose(`onSendMessageError ${JSON.stringify(error)}`);

    const client = await this.clientCw(instance);

    if (!client) {
      return;
    }

    if (error && error?.status === 400 && error?.message[0]?.exists === false) {
      client.messages.create({
        accountId: this.provider.accountId,
        conversationId: conversation,
        data: {
          content: `${i18next.t('cw.message.numbernotinwhatsapp')}`,
          message_type: 'outgoing',
          private: true,
        },
      });

      return;
    }

    client.messages.create({
      accountId: this.provider.accountId,
      conversationId: conversation,
      data: {
        content: i18next.t('cw.message.notsent', {
          error: error ? `_${error.toString()}_` : '',
        }),
        message_type: 'outgoing',
        private: true,
      },
    });
  }

  public async receiveWebhook(instance: InstanceDto, body: any) {
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
        const message = await this.prismaRepository.message.findFirst({
          where: {
            chatwootMessageId: body.id,
            instanceId: instance.instanceId,
          },
        });

        if (message) {
          const key = message.key as WAMessageKey;

          // Delete for everyone (both mobile and WhatsApp Web)
          await waInstance?.client.sendMessage(key.remoteJid, { 
            delete: key,
            revoke: true 
          });

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
          waInstance.clearCacheChatwoot();
          await this.createBotMessage(
            instance,
            i18next.t('cw.inbox.clearCache', {
              inboxName: body.inbox.name,
            }),
            'incoming',
          );
        }

        if (command === 'sync' || command === 'lost') {
          await this.createBotMessage(
            instance,
            '🔄 Sincronizando mensagens perdidas das últimas 6 horas...',
            'incoming',
          );

          try {
            const chatwootConfig = await waInstance.findChatwoot();
            const prepare = (message: any) => {
              // Prepara mensagem (mesmo formato do baileys)
              return message;
            };
            
            await this.syncLostMessages(instance, chatwootConfig, prepare);
            
            await this.createBotMessage(
              instance,
              '✅ Sincronização concluída! Verifique se as mensagens apareceram.',
              'incoming',
            );
          } catch (error) {
            this.logger.error(`Erro ao sincronizar mensagens: ${error}`);
            await this.createBotMessage(
              instance,
              '❌ Erro ao sincronizar mensagens. Tente novamente mais tarde.',
              'incoming',
            );
          }
        }

        if (command === 'restart' || command === 'reiniciar') {
          await this.createBotMessage(
            instance,
            '🔄 Reiniciando conexão do WhatsApp...',
            'incoming',
          );

          try {
            // Usa o mesmo método do endpoint /instance/restart
            if (typeof waInstance.restart === 'function') {
              await waInstance.restart();
            } else {
              // Fallback para Baileys
              waInstance.client?.ws?.close();
              waInstance.client?.end(new Error('restart'));
            }
            
            await new Promise(resolve => setTimeout(resolve, 2000)); // Aguarda 2s
            
            await this.createBotMessage(
              instance,
              '✅ Reconexão iniciada! Aguarde alguns segundos...',
              'incoming',
            );
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
            await new Promise(resolve => setTimeout(resolve, 2000)); // Aguarda 2s
            
            await this.createBotMessage(
              instance,
              '✅ Desconectado! Use /init para gerar um novo QR Code.',
              'incoming',
            );
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

              const options: Options = {
                quoted: await this.getQuotedMessage(body, instance),
              };

              const messageSent = await this.sendAttachment(
                waInstance,
                chatId,
                attachment.data_url,
                formatText,
                options,
              );
              if (!messageSent && body.conversation?.id) {
                this.onSendMessageError(instance, body.conversation?.id);
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
            }
          } else {
            const data: SendTextDto = {
              number: chatId,
              text: formatText,
              delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500,
              quoted: await this.getQuotedMessage(body, instance),
            };

            sendTelemetry('/message/sendText');

            let messageSent: any;
            try {
              messageSent = await waInstance?.textMessage(data, true);
              if (!messageSent) {
                throw new Error('Message not sent');
              }

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
              if (!messageSent && body.conversation?.id) {
                this.onSendMessageError(instance, body.conversation?.id, error);
              }
              throw error;
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

      return { message: 'bot' };
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
    };

    return types;
  }

  private getMessageContent(types: any) {
    const typeKey = Object.keys(types).find((key) => types[key] !== undefined);

    let result = typeKey ? types[typeKey] : undefined;

    // Remove externalAdReplyBody| in Chatwoot (Already Have)
    if (result && typeof result === 'string' && result.includes('externalAdReplyBody|')) {
      result = result.split('externalAdReplyBody|').filter(Boolean).join('');
    }

    if (typeKey === 'viewOnceMessageV2') {
      return '🔒 *Mensagem de visualização única*\n\n_Esta mensagem só pode ser visualizada uma vez no celular. Por segurança, o WhatsApp não permite que ela seja acessada pela API._';
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
            const pixSettings = params.payment_settings?.find(s => s.type === 'pix_static_code');
            
            if (pixSettings) {
              const pix = pixSettings.pix_static_code;
              const amount = params.total_amount?.value / 100 || 0;
              
              // Translate key type to Portuguese
              const keyTypeMap = {
                'PHONE': 'Celular',
                'CPF': 'CPF',
                'CNPJ': 'CNPJ',
                'EMAIL': 'E-mail',
                'EVP': 'Chave aleatória'
              };
              const keyTypeLabel = keyTypeMap[pix.key_type] || pix.key_type;
              
              return `💰 *Pagamento PIX*\n\n` +
                `_Valor:_ R$ ${amount.toFixed(2)}\n` +
                `_Beneficiário:_ ${pix.merchant_name}\n` +
                `_Chave PIX (${keyTypeLabel}):_ ${pix.key}\n` +
                `_Referência:_ ${params.reference_id}\n\n` +
                `_Esta é uma solicitação de pagamento. Verifique no celular para pagar._`;
            }
          }
        }
        
        // Generic interactive message
        return '📱 *Mensagem interativa*\n\n_Esta mensagem contém botões ou elementos interativos. Visualize no celular para interagir._';
      } catch (error) {
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

    return result;
  }

  public getConversationMessage(msg: any) {
    const types = this.getTypeMessage(msg);

    const messageContent = this.getMessageContent(types);

    return messageContent;
  }

  public async eventWhatsapp(event: string, instance: InstanceDto, body: any) {
    try {
      // ✅ Anti-duplicata: Verifica se mensagem já foi processada
      if (event === Events.MESSAGES_UPSERT && body?.key?.id) {
        const messageId = `${instance.instanceName}_${body.key.id}`;
        
        if (messageDeduplicationCache.isDuplicate(messageId)) {
          this.logger.verbose(`Mensagem duplicada ignorada: ${body.key.id}`);
          return null;
        }
        
        // 🔧 FIX: NÃO marca como processada aqui!
        // Só marca DEPOIS que a mensagem for enviada com sucesso
        // Caso contrário, se falhar e ir pra fila, não consegue reprocessar
      }

      const waInstance = this.waMonitor.waInstances[instance.instanceName];

      if (!waInstance) {
        this.logger.warn('wa instance not found');
        return null;
      }

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
        this.logger.info(`[${event}] New message received - Instance: ${JSON.stringify(body, null, 2)}`);
        if (body.key.remoteJid === 'status@broadcast') {
          return;
        }

        if (body.message?.ephemeralMessage?.message) {
          body.message = {
            ...body.message?.ephemeralMessage?.message,
          };
        }

        const originalMessage = await this.getConversationMessage(body.message);
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
          fileStream._read = () => { };
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

            // Get the original message that was reacted to
            const reactedToMsg = await this.prismaRepository.message.findFirst({
              where: {
                key: {
                  path: ['id'],
                  equals: reactionMessage.key.id,
                },
                instanceId: instance.instanceId,
              },
            });

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
          const mimeType = extension && mimeTypes.lookup(extension);

          if (!mimeType) {
            this.logger.warn('mimetype of Ads message not found');
            return;
          }

          const random = Math.random().toString(36).substring(7);
          const nameFile = `${random}.${mimeTypes.extension(mimeType)}`;
          const fileData = Buffer.from(imgBuffer.data, 'binary');

          const img = await Jimp.read(fileData);
          await img.cover({
            w: 320,
            h: 180,
          });
          const processedBuffer = await img.getBuffer(JimpMime.png);

          const fileStream = new Readable();
          fileStream._read = () => { }; // _read is required but you can noop it
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
        // Anti-dup local (process-wide) por 15s (Otimizado para 1 contêiner)

        const dedupKey = `cw_del_${instance.instanceId}_${body?.key?.id}`;
        const g = (global as any);
        if (!g.__cwDel) g.__cwDel = new Map<string, number>();

        const last = g.__cwDel.get(dedupKey);
        const now = Date.now();

        if (last && now - last < 15000) {
          this.logger.info(`[CW.DELETE] Ignorado (duplicado local) para ${body?.key?.id}`);
          return;
        }

        g.__cwDel.set(dedupKey, now);

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
          fileStream._read = () => { };
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
    } catch (error) {
      const errorMsg = error?.message || String(error);
      const messageId = body?.key?.id || 'unknown';
      
      this.logger.error(
        `❌ Erro ao processar evento ${event} (messageId: ${messageId}): ${errorMsg}`
      );
      
      // Log adicional para debug
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
      if (!this.isImportHistoryAvailable()) {
        return;
      }
      if (!this.configService.get<Database>('DATABASE').SAVE_DATA.MESSAGE_UPDATE) {
        return;
      }

      const inbox = await this.getInbox(instance);

      const sqlMessages = `select * from messages m
      where account_id = ${chatwootConfig.accountId}
      and inbox_id = ${inbox.id}
      and created_at >= now() - interval '6h'
      order by created_at desc`;

      const messagesData = (await this.pgClient.query(sqlMessages))?.rows;
      const ids: string[] = messagesData
        .filter((message) => !!message.source_id)
        .map((message) => message.source_id.replace('WAID:', ''));

      const savedMessages = await this.prismaRepository.message.findMany({
        where: {
          Instance: { name: instance.instanceName },
          messageTimestamp: { gte: Number(dayjs().subtract(6, 'hours').unix()) },
          AND: ids.map((id) => ({ key: { path: ['id'], not: id } })),
        },
      });

      const filteredMessages = savedMessages.filter(
        (msg: any) => !chatwootImport.isIgnorePhoneNumber(msg.key?.remoteJid),
      );
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

      await chatwootImport.importHistoryMessages(instance, this, inbox, this.provider, false); // 🔧 Não mostra mensagens do bot no cron (silencioso)
      const waInstance = this.waMonitor.waInstances[instance.instanceName];
      waInstance.clearCacheChatwoot();
    } catch {
      return;
    }
  }
}