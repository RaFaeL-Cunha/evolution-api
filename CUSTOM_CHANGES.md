# Alterações Customizadas - Evolution API

Este arquivo documenta todas as alterações customizadas feitas na Evolution API que devem ser mantidas após atualizações.

## 📝 Lista de Alterações

### 1. Fix: signDelimiter não sendo salvo no CREATE (Chatwoot)

**Arquivo:** `src/api/services/channel.service.ts`  
**Linha:** ~304  
**Problema:** Campo `signDelimiter` não estava sendo salvo ao criar nova configuração do Chatwoot  
**Solução:** Adicionar `signDelimiter` no método `create`

**Código a adicionar:**
```typescript
await this.prismaRepository.chatwoot.create({
  data: {
    enabled: data?.enabled,
    accountId: data.accountId,
    token: data.token,
    url: data.url,
    nameInbox: data.nameInbox,
    signMsg: data.signMsg,
    signDelimiter: data.signMsg ? data.signDelimiter : null, // ← ADICIONAR ESTA LINHA
    number: data.number,
    reopenConversation: data.reopenConversation,
    conversationPending: data.conversationPending,
    mergeBrazilContacts: data.mergeBrazilContacts,
    importContacts: data.importContacts,
    importMessages: data.importMessages,
    daysLimitImportMessages: data.daysLimitImportMessages,
    organization: data.organization,
    logo: data.logo,
    ignoreJids: data.ignoreJids,
    instanceId: this.instanceId,
  },
});
```

---

### 2. Feature: URLs de mídias no endpoint fetchMessages

**Arquivo:** `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`  
**Linhas:** ~6370 e ~6390  
**Problema:** Endpoint `/chat/findMessages` não retornava URLs das mídias (áudio, imagem, vídeo)  
**Solução:** Adicionar JOIN com tabela Media e gerar mediaUrl automaticamente

#### Alteração 1: Adicionar Media no SELECT (~linha 6370)

**Procurar por:**
```typescript
select: {
  id: true,
  key: true,
  pushName: true,
  messageType: true,
  message: true,
  messageTimestamp: true,
  instanceId: true,
  source: true,
  contextInfo: true,
  MessageUpdate: { select: { status: true } },
},
```

**Adicionar:**
```typescript
select: {
  id: true,
  key: true,
  pushName: true,
  messageType: true,
  message: true,
  messageTimestamp: true,
  instanceId: true,
  source: true,
  contextInfo: true,
  MessageUpdate: { select: { status: true } },
  Media: { select: { fileName: true, type: true, mimetype: true } }, // ← ADICIONAR ESTA LINHA
},
```

#### Alteração 2: Gerar mediaUrl (~linha 6390)

**Procurar por:**
```typescript
const formattedMessages = messages.map((message) => {
  const messageKey = message.key as {
    fromMe: boolean;
    remoteJid: string;
    id: string;
    participant?: string;
  };

  if (!message.pushName) {
    if (messageKey.fromMe) {
      message.pushName = 'Você';
    } else if (message.contextInfo) {
      const contextInfo = message.contextInfo as { participant?: string };
      if (contextInfo.participant) {
        message.pushName = contextInfo.participant.split('@')[0];
      } else if (messageKey.participant) {
        message.pushName = messageKey.participant.split('@')[0];
      }
    }
  }

  return message;
});
```

**Substituir por:**
```typescript
const formattedMessages = messages.map((message) => {
  const messageKey = message.key as {
    fromMe: boolean;
    remoteJid: string;
    id: string;
    participant?: string;
  };

  if (!message.pushName) {
    if (messageKey.fromMe) {
      message.pushName = 'Você';
    } else if (message.contextInfo) {
      const contextInfo = message.contextInfo as { participant?: string };
      if (contextInfo.participant) {
        message.pushName = contextInfo.participant.split('@')[0];
      } else if (messageKey.participant) {
        message.pushName = messageKey.participant.split('@')[0];
      }
    }
  }

  // ← ADICIONAR ESTE BLOCO
  // Adiciona URL da mídia se existir
  if (message['Media'] && message['Media'].fileName) {
    const s3Config = this.configService.get<S3>('S3');
    if (s3Config.ENABLE) {
      const protocol = s3Config.USE_SSL ? 'https' : 'http';
      const port = s3Config.PORT && s3Config.PORT !== 443 && s3Config.PORT !== 80 ? `:${s3Config.PORT}` : '';
      const endpoint = s3Config.ENDPOINT.replace(/^https?:\/\//, '');
      message['mediaUrl'] = `${protocol}://${endpoint}${port}/${s3Config.BUCKET_NAME}/${message['Media'].fileName}`;
    }
  }
  // ← FIM DO BLOCO

  return message;
});
```

---

## 🔄 Como Aplicar Após Atualização

1. Faça backup deste arquivo
2. Atualize a Evolution API: `git pull origin main`
3. Aplique manualmente cada alteração seguindo este documento
4. Teste as funcionalidades:
   - Criar nova instância Chatwoot e verificar se `signDelimiter` é salvo
   - Buscar mensagens via `/chat/findMessages` e verificar se `mediaUrl` está presente

---

## ✅ Benefícios das Alterações

- **signDelimiter fix**: Corrige bug que impedia personalização do delimitador de assinatura
- **mediaUrl**: Permite visualização de mídias (áudio, imagem, vídeo) em interfaces customizadas
- **Backward compatible**: Não quebra funcionalidades existentes
- **Performance**: Não adiciona overhead significativo

---

## 📞 Suporte

Se houver conflitos ao aplicar as alterações após atualização, revise este documento e aplique manualmente as mudanças nos arquivos correspondentes.
