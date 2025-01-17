import fetch from 'node-fetch'
import { PdfReader } from 'pdfreader'
import { CONFIG } from './config.mjs'
import { chromium } from 'playwright-chromium'
import PromisePool from '@supercharge/promise-pool'
import { pipe, pluck, map, getElementByXPath, delay } from './utils.mjs'

const progressBar = CONFIG.progressBar.create(2, 0, { stats: '' })

const CHINA_ETF = (
  companyCode = '0838EA',
  title = encodeURIComponent('NET ASSET VALUE / INDICATIVE OPTIMUM PORTFOLIO VALUE')
) =>
  `https://www.bursamalaysia.com/market_information/announcements/company_announcement?company=${companyCode}&title=${title}`

async function parsePdf(pdfUrl) {
  const companyNames = new Set()
  const response = await fetch(pdfUrl)
  const buffer = await response.buffer()

  return new Promise((resolve, reject) => {
    let isSedol = false
    new PdfReader().parseBuffer(buffer, function (err, item) {
      if (err) {
        reject(new Error(`Error parsePdf: ${err}`))
        return
      }

      // pdf read end
      if (!item) resolve(Array.from(companyNames))

      if (isSedol) {
        companyNames.add(item.text)
        isSedol = false
      }

      // the easiest way to find stock name is with regex the sedol id
      // and for the next iteration,
      // add the stock name
      if (
        item?.text &&
        typeof item.text === 'string' &&
        !/[a-z]/.test(item.text) && // discard lower case
        /([A-Z]+[0-9]+)+/.test(item.text) && // only grab SEDOL ids
        !CONFIG.CHINA.blackListItems.includes(item.text) // remove black list item
      ) {
        isSedol = true
      }
    })
  })
}

// click the first "NET ASSET VALUE / INDICATIVE OPTIMUM PORTFOLIO VALUE" row at 4th columns.
async function getUpdatedAtAndPdfUrl() {
  const browser = await chromium.launch({ headless: !CONFIG.isDev })
  const page = await browser.newPage()

  try {
    await page.goto(CHINA_ETF())

    // get updatedAt at latest report
    const updatedAt = await page.evaluate(
      ([selector, util]) => {
        let { pipe, map, pluck } = util
        pipe = new Function(`return ${pipe}`)() // eslint-disable-line no-new-func
        map = new Function(`return ${map}`)() // eslint-disable-line no-new-func
        pluck = new Function(`return ${pluck}`)() // eslint-disable-line no-new-func

        return pipe(
          s => document.querySelector(s),
          pluck('textContent'),
          map(text => text.trim()),
          map(date => Date.parse(date)),
          map(timeStamp => Promise.resolve(timeStamp))
        )(selector)
      },
      [
        '#table-announcements tbody td:nth-child(2) .d-none',
        { pipe: pipe.toString(), map: map.toString(), pluck: pluck.toString() },
      ]
    )

    // process of finding pdfUrl
    const latestReportSelector = '#table-announcements tbody td:last-child a'
    await page.evaluate(s => document.querySelector(s).removeAttribute('target'), [latestReportSelector])
    await page.click(latestReportSelector)

    const iframeUrl = await page.evaluate(
      s => Promise.resolve(document.querySelector(s).getAttribute('src')),
      '#bm_ann_detail_iframe'
    )

    const iframeDomain = new URL(iframeUrl).origin
    await page.goto(iframeUrl)
    const pdfUrl = await page.evaluate(
      s => Promise.resolve(document.querySelector(s).getAttribute('href')),
      '.att_download_pdf a'
    )

    return { updatedAt, pdfUrl: `${iframeDomain}${pdfUrl}` }
  } catch (e) {
    throw Error(`Error getUpdatedAtAndPdfUrl: ${e}`)
  } finally {
    await browser.close()
  }
}

// stockNames: string[]
// launch multi-tabs of pages and scrape company name in google.com/search?q={companyname}.
// and then return Array<[exchange: string, code: string, companyName: string]>
// remap(google exchange to TV exchange): SHE === 'SZSE', SHA === 'SSE'
async function getCompanyExchangeAndCode(stockNames) {
  const browser = await chromium.launch({ headless: !CONFIG.isDev })
  const ctx = await browser.newContext()

  // main just search thru google search and grab the stock code and exchange
  const _main = async name => {
    progressBar.increment(1, { stats: `Google search: ${name}` })

    const page = await ctx.newPage()
    const url = `https://google.com/search?q=${encodeURIComponent(name + ' stock price')}`
    await page.goto(url, { waitUntil: 'networkidle' })

    return await page
      .evaluate(
        ([selector, util]) => {
          let { name, getElementByXPath, remapExchange } = util
          remapExchange = JSON.parse(remapExchange)
          getElementByXPath = new Function(`return ${getElementByXPath}`)() // eslint-disable-line no-new-func

          const el = getElementByXPath(selector)

          if (!el) {
            return Promise.resolve(['', '', name])
          }

          let [exchange, code] = el.textContent.replace(/\s/g, '').split(':')

          // eslint-disable-next-line no-prototype-builtins
          if (remapExchange.hasOwnProperty(exchange)) {
            exchange = remapExchange[exchange]
          } else throw new Error(`Failed to remap China exchange: ${exchange}:${code}:${name}`)

          return Promise.resolve([exchange, code, name])
        },
        [
          '//*[@id="knowledge-finance-wholepage__entity-summary"]/div/g-card-section/div/g-card-section/div[2]/div[2]/div[1]',
          {
            name,
            getElementByXPath: getElementByXPath.toString(),
            remapExchange: JSON.stringify(CONFIG.CHINA.remapExchangeFromGoogleToTV),
          },
        ]
      )
      .finally(async () => await page.close())
  }

  // retry have quite number of steps and that's why its not a default method
  const _retry = async name => {
    const noMatches = 'text=No matches...'
    const mainInputBox = `:nth-match([aria-label="Search for stocks, ETFs & more"], 2)`

    const page = await ctx.newPage()
    await page.goto(`https://www.google.com/finance`, { waitUntil: 'networkidle' })

    try {
      let _name = name
      do {
        _name = _name.slice(0, _name.length - 1)
        if (_name.length < 8) {
          return ['', '', name] // failed to identify this stock and just return it as is.
        }

        await page.fill(mainInputBox, _name)
        await delay(1)
        progressBar.update({ stats: `Google finance: ${_name}` })

        // if "No matches..." not exist then press enter and get code and exchange
        const bool = await page.isVisible(noMatches)
        if (!bool) {
          await page.focus(mainInputBox)
          await page.keyboard.down('Enter')
          await delay(2)

          // getting stock code and exchange in url
          let [code, exchange] = await page.evaluate(async () => {
            const split = location.pathname.split('/')
            return Promise.resolve(split[split.length - 1].split(':'))
          })
          // eslint-disable-next-line no-prototype-builtins
          exchange = CONFIG.CHINA.remapExchangeFromGoogleToTV.hasOwnProperty(exchange)
            ? CONFIG.CHINA.remapExchangeFromGoogleToTV[exchange]
            : ''

          return [exchange, code, name]
        }
      } while (await page.isVisible(noMatches))
    } finally {
      await page.close()
    }
  }

  try {
    const { results } = await PromisePool.for(stockNames).process(_main)
    const { success, failed } = results.reduce(
      (acc, stock) => {
        stock[0] === '' ? acc.failed.push(stock) : acc.success.push(stock)
        return acc
      },
      { success: [], failed: [] }
    )

    const failedNames = failed.map(i => i[2])
    const { results: retryResults } = await PromisePool.for(failedNames).process(_retry)

    return [...success, ...retryResults]
  } catch (e) {
    throw Error(`Error getCompanyExchangeAndCode: ${e}`)
  } finally {
    await browser.close()
  }
}

export async function CHINA() {
  try {
    const { updatedAt, pdfUrl } = await getUpdatedAtAndPdfUrl()
    progressBar.increment(1, { stats: 'Success retrieved updatedAt and pdfUrl' })

    let companyNames = await parsePdf(pdfUrl)
    progressBar.increment(1, { stats: 'Success parse pdf' })

    companyNames = CONFIG.isDev ? companyNames.slice(0, 30) : companyNames
    progressBar.update(0)
    progressBar.setTotal(companyNames.length)

    const human = await getCompanyExchangeAndCode(companyNames)

    return {
      human,
      data: human.reduce((acc, stock) => {
        const [exchange, code] = stock
        // some of the stock failed to get exchange and code
        if (exchange === '') {
          return acc
        }

        // eslint-disable-next-line no-prototype-builtins
        if (acc.hasOwnProperty(exchange)) {
          // this will go to main data file
          acc[exchange].list[code] = [1]
        } else {
          acc = {
            ...acc,
            [exchange]: {
              updatedAt,
              shape: CONFIG.CHINA.shape,
              list: {},
            },
          }
        }
        return acc
      }, {}),
    }
  } catch (e) {
    throw Error(`Failed scrape CHINA: ${e}`)
  }
}
