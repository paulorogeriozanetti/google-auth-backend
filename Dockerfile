# Usa a imagem oficial Node.js 20 Alpine Linux como base
FROM node:20-alpine AS builder

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia package.json e package-lock.json (se existir) para o diretório de trabalho
COPY package*.json ./

# Instala as dependências do projeto
RUN npm install --only=production # Otimizado para produção

# Copia o restante do código da aplicação para o diretório de trabalho
COPY . .

# Define a variável PORT (o Railway irá sobrescrever com a porta dinâmica)
# Define um padrão, mas Railway usa o seu <-- COMENTÁRIO MOVIDO
ENV PORT=3000 
# Expõe a porta que a aplicação usará
EXPOSE ${PORT}

# Define o comando padrão para rodar a aplicação
CMD [ "node", "server.js" ]