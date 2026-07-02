FROM node:22-alpine

WORKDIR /app

# Install git so simple-git can spawn git clone commands
RUN apk add --no-cache git

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:prod"]