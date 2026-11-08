import { cpSync } from 'node:fs'

cpSync('src/vendor', 'dist/src/vendor', { recursive: true })

console.log('Copied vendored LINE runtime into dist/src/vendor before alias resolution')
