import { AwsClient } from 'aws4fetch'
import { PAGE_SIZE } from './constants.js'
import { encodeS3Key } from './utils.js'
import { ConfigManager } from './config-manager.js'

/** @typedef {{ key: string; isFolder: boolean; size?: number; lastModified?: string }} FileItem */

class R2RequestError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, retryable?: boolean, cause?: unknown}} [options]
   */
  constructor(message, { status = 0, code = '', retryable = false, cause } = {}) {
    super(message, { cause })
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

/** @param {string | number} value */
const escapeXml = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** @param {string} value */
const decodeXml = (value) =>
  value.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&')

/** @param {string} xml @param {string} tag */
const readXmlTag = (xml, tag) => {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  return decodeXml(match?.[1] ?? '')
}

/** @param {Response} response */
const requestError = (response) =>
  new R2RequestError(`HTTP ${response.status}`, {
    status: response.status,
    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
  })

class R2Client {
  /** @type {AwsClient | null} */
  #client = null
  /** @type {ConfigManager | null} */
  #config = null
  /** @type {(options: any) => AwsClient} */
  #clientFactory
  /** @type {typeof fetch} */
  #fetchImpl

  /** @param {{clientFactory?: (options: any) => AwsClient, fetchImpl?: typeof fetch}} [options] */
  constructor({
    clientFactory = (options) => new AwsClient(options),
    fetchImpl = (input, init) => fetch(input, init),
  } = {}) {
    this.#clientFactory = clientFactory
    this.#fetchImpl = fetchImpl
  }

  /** @param {ConfigManager} configManager */
  init(configManager) {
    this.#config = configManager
    const cfg = configManager.get()
    this.#client = this.#clientFactory({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: 'auto',
    })
  }

  /** @param {string | URL} url @param {RequestInit} init */
  async #signedFetchOnce(url, init) {
    const request = await /** @type {AwsClient} */ (this.#client).sign(url, init)
    try {
      return await this.#fetchImpl(request)
    } catch (cause) {
      throw new R2RequestError('Network request failed', {
        code: 'NETWORK_ERROR',
        retryable: true,
        cause,
      })
    }
  }

  /** @param {string} key @param {string} contentType */
  async createMultipartUpload(key, contentType) {
    const url = new URL(`${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`)
    url.searchParams.set('uploads', '')
    const res = await this.#signedFetchOnce(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
    })
    if (!res.ok) throw requestError(res)
    const uploadId = readXmlTag(await res.text(), 'UploadId')
    if (!uploadId) {
      throw new R2RequestError('Missing UploadId', { code: 'MULTIPART_UPLOAD_ID_MISSING' })
    }
    return uploadId
  }

  /** @param {string} key @param {string} uploadId @param {number} partNumber @param {Blob} body */
  async uploadPart(key, uploadId, partNumber, body) {
    const url = new URL(`${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`)
    url.searchParams.set('partNumber', String(partNumber))
    url.searchParams.set('uploadId', uploadId)
    const res = await this.#signedFetchOnce(url, { method: 'PUT', body })
    if (!res.ok) throw requestError(res)
    const etag = res.headers.get('etag')
    if (!etag) {
      throw new R2RequestError('Multipart ETag is not exposed by CORS', {
        code: 'MULTIPART_ETAG_MISSING',
        retryable: false,
      })
    }
    return etag
  }

  /**
   * @param {string} key
   * @param {string} uploadId
   * @param {{partNumber: number, etag: string}[]} parts
   */
  async completeMultipartUpload(key, uploadId, parts) {
    const url = new URL(`${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`)
    url.searchParams.set('uploadId', uploadId)
    const body = `<CompleteMultipartUpload>${parts
      .map(
        ({ partNumber, etag }) => `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
      )
      .join('')}</CompleteMultipartUpload>`
    const res = await this.#signedFetchOnce(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    })
    if (!res.ok) throw requestError(res)
  }

  /** @param {string} key @param {string} uploadId */
  async abortMultipartUpload(key, uploadId) {
    const url = new URL(`${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`)
    url.searchParams.set('uploadId', uploadId)
    const res = await this.#signedFetchOnce(url, { method: 'DELETE' })
    if (!res.ok) throw requestError(res)
  }

  /** @param {string} [prefix] @param {string} [continuationToken] */
  async listObjects(prefix = '', continuationToken = '') {
    const url = new URL(/** @type {ConfigManager} */ (this.#config).getBucketUrl())
    url.searchParams.set('list-type', '2')
    url.searchParams.set('delimiter', '/')
    url.searchParams.set('max-keys', String(PAGE_SIZE))
    if (prefix) url.searchParams.set('prefix', prefix)
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken)

    const res = await /** @type {AwsClient} */ (this.#client).fetch(url.toString())
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }

    const text = await res.text()
    const doc = new DOMParser().parseFromString(text, 'application/xml')

    /** @type {FileItem[]} */
    const folders = [...doc.querySelectorAll('CommonPrefixes > Prefix')].map((el) => ({
      key: el.textContent ?? '',
      isFolder: true,
    }))

    /** @type {FileItem[]} */
    const files = [...doc.querySelectorAll('Contents')]
      .map((el) => ({
        key: el.querySelector('Key')?.textContent ?? '',
        size: parseInt(el.querySelector('Size')?.textContent ?? '0', 10),
        lastModified: el.querySelector('LastModified')?.textContent ?? '',
        isFolder: false,
      }))
      .filter((f) => f.key !== prefix)

    const isTruncated = doc.querySelector('IsTruncated')?.textContent === 'true'
    const nextToken = doc.querySelector('NextContinuationToken')?.textContent || ''

    return { folders, files, isTruncated, nextToken }
  }

  /**
   * 检查对象是否存在，使用 ListObjectsV2 避免 HEAD 404 污染控制台
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async fileExists(key) {
    const url = new URL(/** @type {ConfigManager} */ (this.#config).getBucketUrl())
    url.searchParams.set('list-type', '2')
    url.searchParams.set('max-keys', '1')
    url.searchParams.set('prefix', key)
    const res = await /** @type {AwsClient} */ (this.#client).fetch(url.toString())
    if (!res.ok) return false
    const text = await res.text()
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    return [...doc.querySelectorAll('Contents > Key')].some((el) => el.textContent === key)
  }

  /** @param {string} key @param {string} contentType */
  async putObjectSigned(key, contentType) {
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const req = await /** @type {AwsClient} */ (this.#client).sign(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
    })
    return { url: req.url, headers: Object.fromEntries(req.headers.entries()) }
  }

  /** @param {string} key */
  async getObject(key) {
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const res = await /** @type {AwsClient} */ (this.#client).fetch(url)
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
    return res
  }

  /** @param {string} key */
  async getPresignedUrl(key) {
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const signed = await /** @type {AwsClient} */ (this.#client).sign(url, {
      method: 'GET',
      aws: { signQuery: true },
    })
    return signed.url
  }

  /** @param {string} key @param {string} filename */
  async getDownloadUrl(key, filename) {
    const base = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const url = new URL(base)
    url.searchParams.set('response-content-disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
    const signed = await /** @type {AwsClient} */ (this.#client).sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true },
    })
    return signed.url
  }

  /** @param {string} key */
  getPublicUrl(key) {
    const cfg = /** @type {ConfigManager} */ (this.#config).get()
    if (cfg.customDomain && cfg.bucketAccess !== 'private') {
      return `${cfg.customDomain}/${encodeS3Key(key)}`
    }
    return null
  }

  /** @param {string} key */
  async headObject(key) {
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const res = await /** @type {AwsClient} */ (this.#client).fetch(url, { method: 'HEAD' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return {
      contentType: res.headers.get('content-type'),
      contentLength: parseInt(res.headers.get('content-length') || '0', 10),
      lastModified: res.headers.get('last-modified'),
      etag: res.headers.get('etag'),
    }
  }

  /** @param {string} key */
  async deleteObject(key) {
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const res = await /** @type {AwsClient} */ (this.#client).fetch(url, { method: 'DELETE' })
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} src @param {string} dest */
  async copyObject(src, dest) {
    const cfg = /** @type {ConfigManager} */ (this.#config).get()
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(dest)}`
    const res = await /** @type {AwsClient} */ (this.#client).fetch(url, {
      method: 'PUT',
      headers: {
        'x-amz-copy-source': `/${cfg.bucket}/${encodeS3Key(src)}`,
      },
    })
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} key @param {string} contentType */
  async updateContentType(key, contentType) {
    const cfg = /** @type {ConfigManager} */ (this.#config).get()
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const res = await /** @type {AwsClient} */ (this.#client).fetch(url, {
      method: 'PUT',
      headers: {
        'x-amz-copy-source': `/${cfg.bucket}/${encodeS3Key(key)}`,
        'x-amz-metadata-directive': 'REPLACE',
        'Content-Type': contentType,
      },
    })
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} prefix */
  async createFolder(prefix) {
    const key = prefix.endsWith('/') ? prefix : prefix + '/'
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const res = await /** @type {AwsClient} */ (this.#client).fetch(url, {
      method: 'PUT',
      headers: { 'Content-Length': '0' },
      body: '',
    })
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }
}

export { R2Client }
