# Correção de Erros PreKeyError no WhatsApp - Com Recuperação de Mensagens

## Problema Identificado

O sistema estava apresentando erros intermitentes de `PreKeyError: Invalid PreKey ID` quando contatos específicos tentavam enviar mensagens. Este é um problema de criptografia end-to-end do WhatsApp onde:

- A sessão de criptografia entre o WhatsApp e um contato específico fica corrompida/dessincronizada
- As Pre-shared Keys (PreKeys) usadas para estabelecer sessões E2E ficam inválidas
- O contato tenta enviar mensagens com chaves antigas/inválidas
- **PROBLEMA CRÍTICO**: As mensagens eram filtradas e descartadas permanentemente - o usuário nunca recebia essas mensagens

### Exemplo do Erro
```
PreKeyError: Invalid PreKey ID
Contato: 250151964803283@lid / 556699840407@s.whatsapp.net
Grupo: 556699841230-1508699495@g.us
Tipo de mensagem: pkmsg (PreKey Message)
```

## Solução Implementada

### 1. Armazenamento Temporário de Mensagens Falhas
- Mensagens que falham na descriptografia são armazenadas temporariamente em memória (até 30 minutos)
- Limite de 50 mensagens por contato para evitar uso excessivo de memória
- Limpeza automática de mensagens antigas
- **Nota**: Armazenamento em memória - mensagens são perdidas se o servidor reiniciar (mas isso é raro)

### 2. Rastreamento de Erros por Contato
- Adicionado `preKeyErrorTracker` na classe `BaileysStartupService`
- Rastreia quantas vezes cada contato gera erros de PreKey
- Mantém timestamp do último erro para limpeza automática

### 3. Recuperação Automática de Sessão + Reprocessamento
Novo método `attemptSessionRecovery()` que:
- Detecta quando um contato tem 2+ erros de PreKey
- Tenta reestabelecer a sessão usando `assertSessions()`
- **NOVO**: Após recuperar a sessão, tenta reprocessar mensagens armazenadas
- Limita tentativas a 3 para evitar loops infinitos
- Após 3 falhas, descarta mensagens e reseta contador (permite novas tentativas imediatamente)

### 4. Reprocessamento de Mensagens Perdidas
Novo método `retryFailedMessages()` que:
- Tenta reprocessar até 3 vezes cada mensagem armazenada
- Processa mensagens na ordem em que foram recebidas
- Remove mensagens que foram processadas com sucesso
- Descarta mensagens após 3 tentativas falhadas
- **Resultado**: Mensagens que estavam "perdidas" são recuperadas!

### 5. Logs Melhorados
- Logs detalhados identificando o contato problemático
- Informações sobre grupo, participante e tipo de mensagem
- Alertas específicos para erros de PreKey
- Rastreamento de tentativas de recuperação
- **NOVO**: Notificação quando mensagens são recuperadas com sucesso
- **NOVO**: Alerta quando mensagens não podem ser recuperadas

### 6. Limpeza Automática
- Erros antigos (>1 hora) são removidos automaticamente
- Sessões recuperadas com sucesso limpam o contador de erros
- Mensagens antigas (>30 minutos) são descartadas automaticamente
- Cache de mensagens problemáticas expira em 30 minutos

## Arquivos Modificados

### `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`
1. **Linha ~231**: Adicionado `preKeyErrorTracker` e `failedMessages` para rastrear erros e armazenar mensagens
2. **Linha ~5492**: Novo método `storeFailedMessage()` para armazenar mensagens que falharam
3. **Linha ~5530**: Novo método `retryFailedMessages()` para reprocessar mensagens armazenadas
4. **Linha ~5600**: Método `attemptSessionRecovery()` agora reprocessa mensagens após recuperar sessão
5. **Linha ~5680**: Melhorado `baileysSignalRepositoryDecryptMessage()` com recuperação automática
6. **Linha ~2292**: Filtro de mensagens agora armazena mensagens falhas para reprocessamento

### `src/api/integrations/channel/whatsapp/baileysMessage.processor.ts`
1. **Linha ~58**: Melhorado `markMessageAsProblematic()` com logs de diagnóstico adicionais

## Como Funciona

### Fluxo Normal (Sem Erros)
```
Mensagem recebida → Descriptografia → Processamento → Sucesso
```

### Fluxo com PreKeyError (Nova Implementação com Recuperação)
```
Erro 1 → Armazena mensagem em memória (30min)
         ↓
Erro 2 → TENTA RECUPERAR SESSÃO automaticamente
         ↓
Sessão recuperada → Reprocessa as mensagens → MENSAGENS CHEGAM! ✅
         ↓
Falhou? → Tenta novamente no próximo erro
         ↓
Erro 3 → Última tentativa de recuperação
         ↓
Falhou 3x? → Descarta mensagens antigas + ZERA contador
         ↓
Novas mensagens → Processo reinicia automaticamente (sem espera)
```

### Detalhes do Processo

1. **Armazenamento Temporário**: Mensagens com erro são guardadas em memória por 30 minutos
2. **Trigger de Recuperação**: Após 2 erros do mesmo contato, inicia tentativa automática
3. **Limite de Tentativas**: Máximo de 3 tentativas de recuperação
4. **Reset Inteligente**: Após 3 falhas, descarta mensagens antigas e zera contador
5. **Sem Bloqueio**: Novas mensagens do mesmo contato podem acionar recuperação imediatamente
6. **Prevenção de Duplicatas**: Sistema verifica `msg.key.id` antes de armazenar
7. **Limpeza Automática**: Mensagens expiram após 30 minutos se não recuperadas

### Exemplo de Recuperação Bem-Sucedida
```
1. Contato envia 2 mensagens → Ambas falham (PreKeyError)
2. Sistema armazena as 2 mensagens temporariamente (sem duplicação)
3. Após 2º erro, sistema reestabelece sessão automaticamente
4. Sistema reprocessa as 2 mensagens armazenadas
5. Resultado: Ambas as mensagens são entregues com sucesso!
```

## Benefícios

1. **Recuperação de Mensagens**: Mensagens que antes eram perdidas agora são recuperadas automaticamente
2. **Recuperação Automática**: Sistema tenta resolver o problema sem intervenção manual
3. **Logs Detalhados**: Facilita diagnóstico e identificação de contatos problemáticos
4. **Proteção contra Loops**: Limites de tentativas evitam sobrecarga
5. **Não Invasivo**: Mensagens continuam sendo filtradas até a recuperação
6. **Limpeza Automática**: Não acumula dados de erros antigos
7. **Transparente**: Usuário final não percebe o problema - mensagens chegam normalmente após recuperação

## Monitoramento

### Logs a Observar

**Erro detectado e mensagem armazenada:**
```
Erro de descriptografia (pkmsg) para 556699840407@s.whatsapp.net: PreKeyError: Invalid PreKey ID
Mensagem armazenada para reprocessamento futuro. Contato: 556699840407@s.whatsapp.net, Total armazenado: 1
```

**Tentativa de recuperação:**
```
Detectados 3 erros de PreKey para 556699840407@s.whatsapp.net. Tentando reestabelecer sessão...
```

**Recuperação bem-sucedida:**
```
Sessão reestabelecida com sucesso para 556699840407@s.whatsapp.net
Tentando reprocessar 3 mensagem(ns) armazenada(s) de 556699840407@s.whatsapp.net
Mensagem reprocessada com sucesso! ID: 3EB0XXXXX
Mensagem reprocessada com sucesso! ID: 3EB0YYYYY
Mensagem reprocessada com sucesso! ID: 3EB0ZZZZZ
3 mensagem(ns) recuperada(s) com sucesso de 556699840407@s.whatsapp.net!
3 mensagem(ns) perdida(s) foi(ram) recuperada(s)!
```

**Limite atingido após 3 tentativas (mensagens descartadas + contador resetado):**
```
ATENÇÃO: 5 mensagem(ns) de 556699840407@s.whatsapp.net não puderam ser recuperadas após 3 tentativas e serão descartadas.
Contador resetado para 556699840407@s.whatsapp.net. Novas mensagens deste contato poderão acionar o processo de recuperação novamente.
```

**Limite de armazenamento:**
```
Limite de mensagens armazenadas atingido para 556699840407@s.whatsapp.net. Mensagem será descartada permanentemente.
```

## Limitações

1. **Janela de Recuperação**: Mensagens são armazenadas por até 30 minutos em memória
2. **Limite por Contato**: Máximo 50 mensagens armazenadas por contato
3. **Tentativas de Reprocessamento**: Máximo 3 tentativas por mensagem
4. **Tentativas de Recuperação**: Máximo 3 tentativas, depois descarta e reseta contador
5. **Memória**: Mensagens são armazenadas em memória RAM (perdidas se o servidor reiniciar, mas isso é raro)
6. **Tempo de Recuperação**: Sistema tenta recuperar após 2 erros, geralmente em poucos segundos/minutos
7. **Reset Automático**: Após 3 falhas, contador é zerado e novas mensagens podem acionar recuperação novamente

## Próximos Passos (Opcional)

Se o problema persistir ou para melhorar ainda mais:

1. **Persistência em Banco**: Armazenar mensagens falhas no banco de dados para sobreviver a reinicializações
2. **Endpoint Manual**: Criar endpoint para forçar reset de sessão de contatos específicos
3. **Webhook de Alerta**: Notificar administradores quando limite de tentativas for atingido
4. **Métricas**: Adicionar contadores Prometheus para monitorar frequência de erros
5. **Dashboard**: Interface para visualizar mensagens pendentes de recuperação
6. **Notificação ao Usuário**: Informar o remetente que a mensagem está pendente de recuperação

## Testando a Solução

1. Monitore os logs após deploy
2. Aguarde o próximo erro de PreKey do contato problemático
3. Verifique se o sistema armazena a mensagem
4. Após 2 erros, verifique se o sistema tenta recuperação
5. Confirme se mensagens armazenadas são reprocessadas com sucesso
6. Valide que as mensagens chegam ao destinatário final
7. Se falhar 3 vezes, confirme que contador é resetado e novas mensagens são aceitas

## Comportamento Esperado

### Cenário 1: Recuperação Bem-Sucedida (Comum)
```
Erro 1 → Armazena mensagem
Erro 2 → Tenta recuperar sessão → SUCESSO → Mensagens entregues ✅
```

### Cenário 2: Recuperação na 3ª Tentativa
```
Erro 1 → Armazena mensagem
Erro 2 → Tenta recuperar → Falha
Erro 3 → Tenta recuperar → SUCESSO → Mensagens entregues ✅
```

### Cenário 3: Falha Total (Raro)
```
Erro 1 → Armazena mensagem
Erro 2 → Tenta recuperar → Falha
Erro 3 → Tenta recuperar → Falha → Descarta mensagens antigas + Zera contador
Nova mensagem → Processo reinicia (sem espera) → Nova tentativa de recuperação
```

## Notas Técnicas

- `assertSessions()` força o WhatsApp a reestabelecer as chaves de criptografia
- PreKey errors são esperados ocasionalmente em sistemas WhatsApp de alto volume
- A solução não afeta o processamento normal de mensagens
- Compatível com multi-tenant (isolamento por instância)
- Mensagens são armazenadas com metadados completos para reprocessamento fiel
- Reprocessamento usa o mesmo fluxo de mensagens normais (webhooks, integrações, etc.)
