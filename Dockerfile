FROM oven/bun:1

WORKDIR /app

COPY package.json ./
RUN bun install

COPY . .

EXPOSE 3000

ENV PORT=3000

CMD ["bun", "run", "api/index.ts"]
