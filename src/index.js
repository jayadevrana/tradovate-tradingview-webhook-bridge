import { start } from './server.js'

process.on('unhandledRejection', (e) => {
  // never let a stray rejection kill the service
  // eslint-disable-next-line no-console
  console.error('unhandledRejection', e)
})

start()
