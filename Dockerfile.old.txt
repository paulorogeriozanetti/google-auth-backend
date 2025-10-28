# Etapa de build
FROM node:18-alpine

# Cria diretório de trabalho
WORKDIR /app

# Copia arquivos de dependências
COPY package*.json ./

# Instala dependências
RUN npm install

# Copia o restante do app
COPY . .

# Expõe a porta do seu app (ajuste se necessário)
EXPOSE 8080

# Comando para iniciar o app
CMD ["node", "server.js"]