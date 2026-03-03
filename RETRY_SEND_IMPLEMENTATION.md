# Implementação da Flag retry_send

## Resumo

Sistema completo para evitar duplicação de mensagens quando o botão "Reenviar" é clicado no Chatwoot.

## Como Funciona

1. **Chatwoot envia retry** → Evolution recebe webhook com `retry_send=true` no `content_attributes`
2. **Evolution salva no cache** → `chatwoot:retry:instanceName:messageId` (TTL: 5 minutos)
3. **Evolution envia para WhatsApp** → Mensagem é enviada normalmente
4. **WhatsApp confirma** → Evento `send.message` é disparado
5. **Evolution verifica cache** → Encontra flag de retry
6. **Evolution NÃO envia webhook** → Evita duplicação no Chatwoot
7. **Cache é limpo** → Flag é removida após verificação

## Resultado

✅ Mensagem é enviada para o WhatsApp
✅ Mensagem NÃO duplica no Chatwoot
✅ Mensagem vermelha fica azul (Chatwoot atualiza automaticamente)

---

## Implementação Completa

### 1. Detecção da Flag (linha ~1869)

Quando o Chatwoot envia uma mensagem com `retry_send=true`, salvamos no cache:

```typescript
// 🔍 Verifica se é retry (reenvio) - flag adicionada pelo Chatwoot no content_attributes raiz
const isRetry = body?.content_attributes?.retry_send === true;

if (isRetry) {
  this.logger.verbose(
    `Mensagem ${body.id} tem flag retry_send=true, salvando no cache para não enviar webhook de volta`,
  );
  // Salva no cache com o chatwootMessageId para verificar depois
  const cacheKey = `chatwoot:retry:${instance.instanceName}:${body.id}`;
  await this.cache.set(cacheKey, true, 300); // 5 minutos
}
```

**Formato do webhook recebido do Chatwoot:**
```json
{
  "event": "message_created",
  "id": 12345,
  "content": "Olá mundo",
  "content_attributes": {
    "retry_send": true  // ← FLAG ESTÁ AQUI (nível raiz da mensagem)
  },
  "message_type": "outgoing",
  "conversation": { ... }
}
```

### 2. Verificação no Webhook (linha ~2624)

Quando o WhatsApp confirma o envio, verificamos o cache antes de enviar webhook:

```typescript
// 🔍 Verifica se é mensagem de retry para não enviar webhook de volta
if (body.key.fromMe && messageType === 'outgoing') {
  // Busca a mensagem no banco para pegar o chatwootMessageId
  const existingMessage = await this.prismaRepository.message.findFirst({
    where: {
      instanceId: instance.instanceId,
      key: {
        path: ['id'],
        equals: body.key.id,
      },
    },
  });

  if (existingMessage?.chatwootMessageId) {
    // Verifica se tem flag de retry no cache
    const cacheKey = `chatwoot:retry:${instance.instanceName}:${existingMessage.chatwootMessageId}`;
    const isRetry = await this.cache.get(cacheKey);

    if (isRetry) {
      this.logger.verbose(
        `Mensagem ${body.key.id} é retry (chatwootMessageId: ${existingMessage.chatwootMessageId}), não enviando webhook (evita duplicação)`,
      );
      // Remove do cache
      await this.cache.delete(cacheKey);
      return;
    }
  }
}
```

### 3. Tratamento de Erros 4xx vs 5xx (linha ~1577)

Método auxiliar para distinguir erros de validação (4xx) de erros de servidor (5xx):

```typescript
/**
 * 🔍 Verifica se o erro permite retry (apenas erros 5xx)
 * Erros 4xx (400, 422, etc) são de validação e não devem mostrar erro no Chatwoot
 */
private shouldAllowRetry(error: any): boolean {
  if (!error) return true;
  
  const status = error?.status || error?.response?.status;
  
  if (!status) return true;
  
  // Apenas erros 5xx (servidor) permitem retry
  // Erros 4xx (cliente/validação) retornam sucesso silenciosamente
  return status >= 500;
}
```

### 4. Uso no Envio de Mensagens (linha ~1950 e ~2020)

```typescript
try {
  messageSent = await retryWithBackoff(...);
  // ... atualiza Chatwoot
} catch (error) {
  const shouldRetry = this.shouldAllowRetry(error);

  if (shouldRetry && !messageSent && body.conversation?.id) {
    // Erro 5xx: Mostra erro no Chatwoot (mensagem fica vermelha)
    this.onSendMessageError(instance, body.conversation?.id, error);
    throw error;
  } else if (!shouldRetry) {
    // Erro 4xx: Log detalhado mas retorna sucesso (mensagem fica azul)
    this.logger.warn(
      `[400/422] Erro de validação - Ignorando para UX:\n` +
      `  ChatId: ${chatId}\n` +
      `  Status: ${error?.status}\n` +
      `  Full Error: ${JSON.stringify(error)}`
    );
    return { message: 'bot' };
  }
}
```

---

## Comportamento por Tipo de Erro

### Erro 500 (Internal Server Error)
- ❌ Mensagem NÃO vai para o WhatsApp
- 🔴 Mensagem fica vermelha no Chatwoot
- 🔄 Botão "Reenviar" aparece
- ⚠️ Usuário vê o erro e pode tentar novamente

### Erro 400/422 (Bad Request/Validation)
- ❌ Mensagem NÃO vai para o WhatsApp
- 🔵 Mensagem fica azul no Chatwoot (sem erro visível)
- ❌ Botão "Reenviar" NÃO aparece
- 📝 Apenas log no servidor (UX não é afetado)

### Timeout (>60 segundos)
- ❌ Chatwoot cancela a requisição
- 🔴 Mensagem fica vermelha
- 🔄 Botão "Reenviar" aparece
- ⏱️ Mostra erro de timeout

---

## Validações Adicionais

### Texto Vazio (linha ~1957)
Previne erro 400 ao tentar enviar mensagem vazia:

```typescript
if (!formatText || formatText.trim() === '') {
  this.logger.warn(`[VALIDAÇÃO] Texto vazio detectado - Ignorando envio (chatId: ${chatId})`);
  return { message: 'bot' };
}
```

### Comandos do Bot (chatId === '123456')
Comandos do bot são ignorados pelo sistema de envio do Chatwoot e processados internamente.

---

## Integração com Chatwoot

### Mudanças no Chatwoot (feitas pelo usuário)

1. **send_reply_job.rb** - Usa `Api::SendOnApiService`
2. **send_on_api_service.rb** - Detecta Evolution API e envia via Evolution
3. **retry_message_service.rb** - Adiciona flag `retry_send: true` ao reenviar
4. **Timeout configurado** - 60 segundos em todas as requisições HTTP

### Flags no content_attributes

- `forwarded: true` → Mensagem encaminhada (já implementado, não mexer)
- `retry_send: true` → Mensagem reenviada (NOVO)

---

## Arquivos Modificados

- `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts`
  - Linha ~1577: Método `shouldAllowRetry()`
  - Linha ~1869: Detecção da flag `retry_send`
  - Linha ~1950: Tratamento de erros em anexos
  - Linha ~1957: Validação de texto vazio
  - Linha ~2020: Tratamento de erros em mensagens de texto
  - Linha ~2624: Verificação do cache antes de enviar webhook

---

## Logs para Debug

### Quando detecta retry
```
Mensagem 12345 tem flag retry_send=true, salvando no cache para não enviar webhook de volta
```

### Quando pula webhook
```
Mensagem ABC123 é retry (chatwootMessageId: 12345), não enviando webhook (evita duplicação)
```

### Quando detecta erro 4xx
```
[400/422] Erro de validação ao enviar mensagem - Ignorando para UX:
  ChatId: 5511999999999
  Text: Olá mundo
  Status: 400
  Message: Invalid number format
  Full Error: {...}
```

---

## Testes Recomendados

1. ✅ Enviar mensagem normal → Deve aparecer no Chatwoot
2. ✅ Forçar erro 500 → Mensagem vermelha com botão "Reenviar"
3. ✅ Clicar "Reenviar" → Mensagem fica azul, não duplica
4. ✅ Forçar erro 400 → Mensagem azul, sem botão "Reenviar"
5. ✅ Enviar texto vazio → Ignorado silenciosamente
6. ✅ Comandos do bot → Processados internamente, não enviam via Evolution
