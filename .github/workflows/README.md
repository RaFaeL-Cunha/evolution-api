# GitHub Actions Workflows

## 📦 Workflow: Build and Publish GHCR image

Este workflow automatiza a publicação de imagens Docker em dois registries:
- **GitHub Container Registry (GHCR)** - `ghcr.io/rafael-cunha/evolution-api`
- **Docker Hub** - `cunharafa/soconnect`

### 🔄 Quando é executado:

1. **Push na branch `main`** → Publica automaticamente
2. **Push de tag `v*`** (ex: `v2.3.7`) → Publica com versão
3. **Manual** → Via GitHub Actions UI

### 📦 Imagens publicadas:

#### GitHub Container Registry (GHCR):
- `ghcr.io/rafael-cunha/evolution-api:latest`
- `ghcr.io/rafael-cunha/evolution-api:main`
- `ghcr.io/rafael-cunha/evolution-api:sha-abc123`
- `ghcr.io/rafael-cunha/evolution-api:v2.3.7` (quando criar tag)

#### Docker Hub:
- `cunharafa/soconnect:evolution-apiv2.3.7Prod2.11`
- `cunharafa/soconnect:latest`
- `cunharafa/soconnect:evolution-apiv2.3.7Prod2.11-v2.3.7` (quando criar tag)

### ⚙️ Configuração necessária:

#### 1. Secrets do GitHub (Settings → Secrets and variables → Actions):

Você precisa adicionar 2 secrets:

```
DOCKERHUB_USERNAME = cunharafa
DOCKERHUB_TOKEN = seu_token_do_docker_hub
```

#### 2. Como criar o Docker Hub Token:

1. Acesse: https://hub.docker.com/settings/security
2. Clique em "New Access Token"
3. Nome: `github-actions-evolution-api`
4. Permissões: `Read, Write, Delete`
5. Copie o token gerado
6. Cole no secret `DOCKERHUB_TOKEN` do GitHub

### 🚀 Como usar:

#### Publicação automática (push):
```bash
git add .
git commit -m "feat: nova funcionalidade"
git push origin main
```

O workflow vai:
1. Buildar a imagem (amd64 + arm64)
2. Publicar no GHCR automaticamente (usa GITHUB_TOKEN)
3. Publicar no Docker Hub (usa seus secrets)

#### Publicação com versão (tag):
```bash
git tag v2.3.8
git push origin v2.3.8
```

Publica com tags de versão em ambos os registries.

#### Publicação manual:
1. GitHub → Actions → "Build and Publish GHCR image"
2. Clique em "Run workflow"
3. Selecione a branch `main`
4. Clique em "Run workflow"

### 🏗️ Recursos:

- ✅ **Multi-arquitetura**: linux/amd64 + linux/arm64
- ✅ **Cache otimizado**: Builds mais rápidos
- ✅ **Tags automáticas**: latest, versão, sha
- ✅ **Dual registry**: GHCR + Docker Hub

### 📊 Monitoramento:

Acompanhe os builds em:
- GitHub → Actions → "Build and Publish GHCR image"

### 🔧 Troubleshooting:

#### Erro: "unauthorized: authentication required"
- Verifique se os secrets `DOCKERHUB_USERNAME` e `DOCKERHUB_TOKEN` estão configurados
- Verifique se o token do Docker Hub não expirou

#### Erro: "denied: permission_denied"
- Verifique se o token tem permissão de escrita (Write)
- Recrie o token com permissões corretas

#### Build lento:
- Primeira build é sempre mais lenta (sem cache)
- Builds subsequentes usam cache e são mais rápidas

### 📝 Notas:

- O GITHUB_TOKEN é automático (não precisa configurar)
- O workflow só roda quando há push na branch `main` ou tags
- Você pode desabilitar o workflow deletando o arquivo ou adicionando `if: false`
