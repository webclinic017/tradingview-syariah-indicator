import fs from 'fs'
import path from 'path'
import fse from 'fs-extra'
import { version } from '../package.json'

const outputFolder = `source-code-tsi--${version}`
const outputZip = `${outputFolder}.zip`
const destination = `scripts/${outputFolder}`
const files = [
  '_locales',
  'assets',
  'src',
  '.babelrc',
  '.env.example',
  'globals.d.ts',
  'manifest.json',
  'package.json',
  'postcss.config.js',
  'tailwind.config.js',
  'tsconfig.json',
  'web-ext-config.js',
  'webpack.config.ts',
].map(file => copy(file))

async function copy(input, dest = destination) {
  try {
    return await fse.copy(path.resolve(process.cwd(), input), path.resolve(process.cwd(), dest, input), {
      overwrite: true,
    })
  } catch (err) {
    console.error(`Failed to copy: ${input}`, err)
    process.exit(1)
  }
}

async function createReadme() {
  try {
    const readme = `
## Tradingview Shariah Indicator (${version})
Requirements
- node = 15.12.0
- yarn = 1.15.2
- git = 2.31.0

Steps
1. Git clone \`git@github.com:AzrizHaziq/tradingview-syariah-indicator.git\`
2. cd tradingview-shariah-indicator && yarn
3. cd packages/extension
3. create \`.env.production\` file in root, and add this
   \`\`\`
   GA=UA-183073441-2
   FETCH_URL=https://raw.githubusercontent.com/AzrizHaziq/tradingview-syariah-indicator/lerna-init/packages/data/stock-list.txt
   \`\`\`
4. Type in terminal \`$ yarn build\`
5. Generated file located in /dist/*
`.trim()

    fs.writeFileSync(`${destination}/README.md`, readme, { encoding: 'utf-8' })

    // eslint-disable-next-line no-console
    console.log(`Success write to README.md`)
  } catch (e) {
    throw new Error(`Error create README.md: ${e}`)
  }
}

async function gzip() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const child_process = require('child_process')
    child_process.execSync(`zip -r scripts/${outputZip} scripts/${outputFolder}`)

    // eslint-disable-next-line no-console
    console.log(`Success zip to ${outputZip}`)
  } catch (e) {
    throw new Error(`Error zip folder: ${e}`)
  }
}

Promise.all(files)
  .then(() => console.log(`success copy to ${destination}`))
  .then(createReadme)
  .then(gzip)
