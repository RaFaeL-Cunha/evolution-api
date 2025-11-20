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
          `Ignoring message with known SessionError: ${messageKey} (participant: ${msg.key.participant || 'N/A'})`
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
      `Message marked as problematic due to SessionError: ${messageKey} ` +
      `(from: ${msg.key.participant || msg.key.remoteJid})`
    );
  }

  mount({ onMessageReceive }: MountProps) {
    // Se já existe subscription, fazer cleanup primeiro
    if (this.subscription && !this.subscription.closed) {
      this.subscription.unsubscribe();
    }

    // Se o Subject foi completado, recriar
    if (this.messageSubject.closed) {
      this.processorLogs.warn('MessageSubject was closed, recreating...');
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
          this.processorLogs.log(`Processing batch of ${messages.length} messages`);
        }),
        // Filter problematic messages before processing
        tap(({ messages }) => {
          const filtered = this.filterProblematicMessages(messages);
          if (filtered.length < messages.length) {
            this.processorLogs.warn(
              `Filtered ${messages.length - filtered.length} problematic messages from batch`
            );
          }
        }),
        concatMap(({ messages, type, requestId, settings }) => {
          const filteredMessages = this.filterProblematicMessages(messages);
          
          // If no valid messages remain, skip processing
          if (filteredMessages.length === 0) {
            this.processorLogs.warn('All messages in batch were filtered out, skipping processing');
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
                      `SessionError detected, marking ${filteredMessages.length} message(s) as problematic`
                    );
                    filteredMessages.forEach((msg) => this.markMessageAsProblematic(msg));
                    // Don't retry for SessionError - it won't resolve without re-establishing encryption
                    throw error;
                  }
                  
                  this.processorLogs.warn(`Retrying message batch due to error: ${errorMsg}`);
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
                  `SessionError encountered, messages have been filtered and will be ignored for 30 minutes`
                );
                return EMPTY;
              }
              
              // Other errors are propagated
              throw error;
            }),
          );
        }),
        catchError((error) => {
          this.processorLogs.error(`Error processing message batch: ${error}`);
          return EMPTY;
        }),
      )
      .subscribe({
        error: (error) => {
          this.processorLogs.error(`Message stream error: ${error}`);
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
