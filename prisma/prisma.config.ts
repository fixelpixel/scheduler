import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: './schema.prisma',
  migrations: {
    directory: './migrations',
  },
  generator: {
    client: {
      provider: 'prisma-client-js',
    },
  },
  database: {
    url: process.env.DATABASE_URL,
  },
})