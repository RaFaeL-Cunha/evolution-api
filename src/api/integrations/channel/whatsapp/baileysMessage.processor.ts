import { Logger } from '@config/logger.config';
import { BaileysEventMap, MessageUpsertType, WAMessage } from 'baileys';
import { catchError, concatMap, delay, EMPTY, from, retryWhen, Subject, Subscription, take, tap } from 'rxjs';

type MessageUpsertPayload = BaileysEventMap['messages.upsert'];
type MountProps = {
  onMessageReceive: (payload: MessageUpsertPayload, settings: any) => Promise<void>;
};

export class BaileysMessageProcessor {
  private processorLogs = new Logger('BaileysMessageProcessor');
  private subscription?: Subscription;
  private sessionErrorCache = new Map<string, number>(); // Track SessionError occurrences

  protected messageSubject = new Subject<{
    messages: WAMessage[];
    type: MessageUpsertType;
    requestId?: string;
    settings: any;
  }>();

  /**
   * Filters messages that have repeatedly caused SessionError
   */
  private filterProblematicMessages(messages: WAMessage[]): WAMessage[] {
    const now = Date.now();
    const CACHE_EXPIRY = 30 * 60 * 1000; // 30 minutes - increased from 5 to reduce retry attempts

    // Clean expired cache entries
    for (const [key, timestamp] of this.sessionErrorCache.entries()) {
      if (now - timestamp > CACHE_EXPIRY) {
        this.sessionErrorCache.delete(key);
      }
    }

    return messages.filter((msg) => {
      if (!msg.key?.id || !msg.key?.remoteJid) return true;

      const messageKey = `${msg.key.remoteJid}_${msg.key.id}_${msg.key.participant || ''}`;
      
      // If message has already caused SessionError, ignore it
      if (this.sessionErrorCache.has(messageKey)) {
        this.processorLogs.warn(
          `Ignorando mensagem com erro de sessão conhecido: ${messageKey} (participante: ${msg.key.participant || 'N/A'})`
        );
        return false;
      }

      return true;
    });
  }

  /**
   * Marks a message as problematic (SessionError)
   */
  private markMessageAsProblematic(msg: WAMessage) {
    if (!msg.key?.id || !msg.key?.remoteJid) return;

    const messageKey = `${msg.key.remoteJid}_${msg.key.id}_${msg.key.participant || ''}`;
    this.sessionErrorCache.set(messageKey, Date.now());
    
    this.processorLogs.warn(
      `Mensagem marcada como problemática devido a erro de sessão: ${messageKey} ` +
      `(de: ${msg.key.participant || msg.key.remoteJid})`
    );
  }

  mount({ onMessageReceive }: MountProps) {
    // Se já existe subscription, fazer cleanup primeiro
    if (this.subscription && !this.subscription.closed) {
      this.subscription.unsubscribe();
    }

    // Se o Subject foi completado, recriar
    if (this.messageSubject.closed) {
      this.processorLogs.warn('MessageSubject foi fechado, recriando...');
      this.messageSubject = new Subject<{
        messages: WAMessage[];
        type: MessageUpsertType;
        requestId?: string;
        settings: any;
      }>();
    }

    this.subscription = this.messageSubject
      .pipe(
        tap(({ messages }) => {
          this.processorLogs.log(`Processando lote de ${messages.length} mensagens`);
        }),
        // Filter problematic messages before processing
        tap(({ messages }) => {
          const filtered = this.filterProblematicMessages(messages);
          if (filtered.length < messages.length) {
            this.processorLogs.warn(
              `Filtradas ${messages.length - filtered.length} mensagens problemáticas do lote`
            );
          }
        }),
        concatMap(({ messages, type, requestId, settings }) => {
          const filteredMessages = this.filterProblematicMessages(messages);
          
          // If no valid messages remain, skip processing
          if (filteredMessages.length === 0) {
            this.processorLogs.warn('Todas as mensagens do lote foram filtradas, pulando processamento');
            return EMPTY;
          }

          return from(
            onMessageReceive({ messages: filteredMessages, type, requestId }, settings)
          ).pipe(
            retryWhen((errors) =>
              errors.pipe(
                tap((error) => {
                  const errorMsg = error?.message || String(error);
                  
                  // Detect SessionError and mark messages as problematic
                  if (errorMsg.includes('SessionError') || errorMsg.includes('No session record')) {
                    this.processorLogs.warn(
                      `Erro de sessão detectado, marcando ${filteredMessages.length} mensagem(ns) como problemática(s)`
                    );
                    filteredMessages.forEach((msg) => this.markMessageAsProblematic(msg));
                    // Don't retry for SessionError - it won't resolve without re-establishing encryption
                    throw error;
                  }
                  
                  this.processorLogs.warn(`Tentando novamente lote de mensagens devido a erro: ${errorMsg}`);
                }),
                delay(1000), // 1 second delay between retries
                take(3), // Maximum 3 retry attempts
              ),
            ),
            catchError((error) => {
              const errorMsg = error?.message || String(error);
              
              // SessionError is not critical - log and continue processing other messages
              if (errorMsg.includes('SessionError') || errorMsg.includes('No session record')) {
                this.processorLogs.warn(
                  `Erro de sessão encontrado, mensagens foram filtradas e serão ignoradas por 30 minutos`
                );
                return EMPTY;
              }
              
              // Other errors are propagated
              throw error;
            }),
          );
        }),
        catchError((error) => {
          this.processorLogs.error(`Erro ao processar lote de mensagens: ${error}`);
          return EMPTY;
        }),
      )
      .subscribe({
        error: (error) => {
          this.processorLogs.error(`Erro no fluxo de mensagens: ${error}`);
        },
      });
  }

  processMessage(payload: MessageUpsertPayload, settings: any) {
    const { messages, type, requestId } = payload;
    this.messageSubject.next({ messages, type, requestId, settings });
  }

  onDestroy() {
    this.subscription?.unsubscribe();
    this.messageSubject.complete();
    this.sessionErrorCache.clear();
  }
}
