# Análise: Perda de Mensagens Chatwoot → WhatsApp

## Resumo do Problema
Mensagens enviadas do Chatwoot às vezes não chegam no WhatsApp dos destinatários. O problema afeta tanto mensagens de texto quanto imagens/anexos.

## Arquitetura Atual

### Fluxo de Mensagens (Chatwoot → WhatsApp)
1. Webhook recebe mensagem do Chatwoot (`receiveWebhook` - linha 1604)
2. Valida instância e tipo de mensagem
3. Formata texto com assinatura do atendente
4. Para cada mensagem:
   - **Anexos**: Chama `sendAttachment` (linha 1491) com retry
   - **Texto**: Chama `waInstance.textMessage` com retry

### Mecanismos de Proteção Existentes

#### 1. Retry com Exponential Backoff (linhas 47-85)
```typescript
// 5 tentativas: 3s, 6s, 12s, 24s, 48s
retryWithBackoff(fn, maxAttempts=5, operationName, baseDelayMs=3000)
```
- ✅ Usado para: criar conversação, criar mensagem no Chatwoot
- ❌ Retorna `null` em caso de falha (não lança exceção)
- ❌ Mensagem é perdida se todas as tentativas falharem

#### 2. Cache Anti-Duplicação (linhas 90-130)
```typescript
// TTL de 5 minutos para evitar duplicatas
messageDeduplicationCache.isDuplicate(messageId)
```
- ✅ Previne mensagens duplicadas
- ⚠️ Pode bloquear retentativas legítimas

#### 3. Cache "Enviando" (linhas 1897, 1967)
```typescript
// Marca mensagem como "enviando" por 30 segundos
await this.cache.set(`cw_sending_${body.id}`, true, 30);
```
- ✅ Previne envios simultâneos da mesma mensagem
- ❌ Se falhar, cache expira mas mensagem não é reenviada

#### 4. Sistema de Recuperação (Cron)
- `syncLostMessages`: Executa a cada 30 minutos
- Recupera mensagens das últimas 6 horas que não foram sincronizadas

## Causas Prováveis de Perda de Mensagens

### 1. Falhas Silenciosas ⚠️ CRÍTICO
**Localização**: `retryWithBackoff` (linha 47)

```typescript
// Retorna null em vez de lançar exceção
if (attempt === maxAttempts) {
  logger.error(`❌ ${operationName} falhou após ${maxAttempts} tentativas`);
  return null; // ❌ Mensagem perdida!
}
```

**Impacto**: 
- Mensagem falha após 5 tentativas (~45 segundos)
- Retorna `null` sem lançar exceção
- Código continua executando como se tudo estivesse OK
- Mensagem só será recuperada pelo cron (30 minutos depois)

### 2. Erros no `sendAttachment` Não Capturados
**Localização**: `sendAttachment` (linha 1491)

```typescript
public async sendAttachment(...) {
  try {
    // ... código de envio
  } catch (error) {
    this.logger.error(error);
    throw error; // ✅ Re-lança erro
  }
}
```

**Problema**: 
- Método lança exceção em caso de erro
- Mas o retry wrapper pode não capturar corretamente
- Erros de rede/timeout podem não ser tratados

### 3. Cache Bloqueando Retentativas
**Localização**: linhas 1897, 1967

```typescript
const cacheKey = `cw_sending_${body.id}`;
if (await this.cache.get(cacheKey)) {
  this.logger.warn('Mensagem já está sendo enviada, ignorando duplicata');
  return { message: 'already_sending' };
}
await this.cache.set(cacheKey, true, 30); // 30 segundos
```

**Problema**:
- Se primeira tentativa falhar, cache permanece por 30s
- Webhook duplicado dentro de 30s será ignorado
- Após 30s, cache expira mas ninguém retenta

### 4. Delays Intencionais (Anti-Ban)
**Localização**: linhas 1531, 1556, 1963

```typescript
// Áudio: delay aleatório 500-2000ms
delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500

// Mídia: delay fixo 1200ms
delay: 1200

// Texto: delay aleatório 500-2000ms
delay: Math.floor(Math.random() * (2000 - 500 + 1)) + 500
```

**Nota**: Estes delays são INTENCIONAIS para evitar ban do WhatsApp. Não são a causa da perda.

### 5. Timeout do Axios (45 segundos)
**Localização**: linha 1455

```typescript
timeout: 45000, // 45s para enviar mídia ao Chatwoot
```

**Problema**:
- Timeout pode ser insuficiente para arquivos grandes
- Conexão lenta pode causar timeout
- Erro de timeout não é sempre recuperável

## Cenários de Perda de Mensagem

### Cenário 1: Falha Total de Conexão
```
1. Chatwoot envia webhook
2. receiveWebhook inicia processamento
3. waInstance.textMessage() falha (WhatsApp offline)
4. Retry 1: falha (3s depois)
5. Retry 2: falha (6s depois)
6. Retry 3: falha (12s depois)
7. retryWithBackoff retorna null
8. onSendMessageError envia mensagem privada no Chatwoot
9. ❌ Mensagem perdida até cron (30 min)
```

### Cenário 2: Timeout em Anexo Grande
```
1. Chatwoot envia webhook com imagem 10MB
2. sendAttachment inicia download
3. Axios timeout após 45s
4. Retry 1: timeout novamente
5. Retry 2: timeout novamente
6. Retry 3: timeout novamente
7. Exceção lançada
8. Cache removido
9. onSendMessageError notifica Chatwoot
10. ❌ Mensagem perdida até cron (30 min)
```

### Cenário 3: Cache Bloqueando Retry
```
1. Chatwoot envia webhook (tentativa 1)
2. Cache marca como "enviando" (30s)
3. Envio falha após 10s
4. Cache ainda ativo (20s restantes)
5. Chatwoot reenvia webhook (tentativa 2)
6. Cache detecta duplicata
7. ❌ Mensagem ignorada
8. Após 30s, cache expira
9. ❌ Ninguém retenta, mensagem perdida até cron
```

## Recomendações de Correção

### 1. Implementar Fila de Mensagens Persistente 🔥 PRIORIDADE ALTA
```typescript
// Usar Redis ou banco de dados para fila
interface QueuedMessage {
  id: string;
  instanceId: string;
  chatwootMessageId: number;
  type: 'text' | 'attachment';
  data: any;
  attempts: number;
  lastAttempt: Date;
  nextRetry: Date;
}

// Ao falhar após retry:
await messageQueue.add({
  id: generateId(),
  instanceId: instance.instanceId,
  chatwootMessageId: body.id,
  type: 'text',
  data: { number: chatId, text: formatText },
  attempts: 0,
  nextRetry: new Date(Date.now() + 60000) // 1 minuto
});
```

### 2. Melhorar Tratamento de Erros
```typescript
// Em vez de retornar null, lançar exceção específica
class MessageSendError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly originalError?: any
  ) {
    super(message);
  }
}

// No retryWithBackoff:
if (attempt === maxAttempts) {
  throw new MessageSendError(
    `Falhou após ${maxAttempts} tentativas`,
    true, // pode retentar
    error
  );
}
```

### 3. Ajustar Estratégia de Cache
```typescript
// Cache mais inteligente
const cacheKey = `cw_sending_${body.id}`;
const sendingInfo = await this.cache.get(cacheKey);

if (sendingInfo) {
  const elapsed = Date.now() - sendingInfo.startTime;
  
  // Se passou mais de 60s, permite retry
  if (elapsed > 60000) {
    this.logger.warn('Retry após timeout de cache');
    await this.cache.delete(cacheKey);
  } else {
    return { message: 'already_sending' };
  }
}

await this.cache.set(cacheKey, {
  startTime: Date.now(),
  attempts: (sendingInfo?.attempts || 0) + 1
}, 60);
```

### 4. Aumentar Timeout para Anexos Grandes
```typescript
// Calcular timeout baseado no tamanho do arquivo
const fileSize = await getFileSize(attachment.data_url);
const timeoutMs = Math.max(45000, fileSize / 1024 * 100); // 100ms por KB

const config = {
  // ...
  timeout: timeoutMs,
  maxContentLength: 50 * 1024 * 1024, // 50MB
};
```

### 5. Adicionar Logging Detalhado
```typescript
// Log estruturado para debug
this.logger.log({
  event: 'message_send_attempt',
  messageId: body.id,
  chatId: chatId,
  type: 'text',
  attempt: attemptNumber,
  timestamp: new Date().toISOString()
});

// Log de falha com contexto completo
this.logger.error({
  event: 'message_send_failed',
  messageId: body.id,
  chatId: chatId,
  error: error.message,
  stack: error.stack,
  retryable: error.retryable,
  willRetry: attemptNumber < maxAttempts
});
```

### 6. Monitoramento e Alertas
```typescript
// Métricas para monitoramento
interface MessageMetrics {
  sent: number;
  failed: number;
  retried: number;
  queued: number;
  avgLatency: number;
}

// Alerta se taxa de falha > 5%
if (metrics.failed / metrics.sent > 0.05) {
  await sendAlert('Alta taxa de falha em mensagens Chatwoot→WhatsApp');
}
```

## Próximos Passos

### Investigação Imediata
1. ✅ Analisar logs de produção para identificar padrões de erro
2. ✅ Verificar se `onSendMessageError` está sendo chamado
3. ✅ Confirmar se cron `syncLostMessages` está recuperando mensagens
4. ✅ Testar cenários de falha em ambiente de desenvolvimento

### Implementação (Ordem de Prioridade)
1. 🔥 **CRÍTICO**: Implementar fila persistente de mensagens
2. 🔥 **CRÍTICO**: Melhorar tratamento de erros (não retornar null)
3. ⚠️ **ALTO**: Ajustar estratégia de cache anti-duplicação
4. ⚠️ **ALTO**: Adicionar logging detalhado
5. 📊 **MÉDIO**: Implementar métricas e monitoramento
6. 📊 **MÉDIO**: Aumentar timeout para anexos grandes

### Testes Necessários
- [ ] Teste de falha de conexão WhatsApp
- [ ] Teste de timeout em anexo grande (>10MB)
- [ ] Teste de webhook duplicado
- [ ] Teste de recuperação via cron
- [ ] Teste de carga (múltiplas mensagens simultâneas)

## Conclusão

A perda de mensagens ocorre principalmente devido a:
1. **Falhas silenciosas**: `retryWithBackoff` retorna `null` em vez de lançar exceção
2. **Falta de fila persistente**: Mensagens falhadas não são enfileiradas para retry posterior
3. **Cache bloqueando retries**: Webhooks duplicados são ignorados mesmo após falha

A solução mais efetiva é implementar uma **fila persistente de mensagens** que garanta que nenhuma mensagem seja perdida, mesmo em caso de falhas temporárias.
