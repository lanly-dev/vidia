#!/usr/bin/env node
/**
 * `npm run key:check` — executable proof that the extension's key-verdict logic works.
 *
 * `src/keyVerifier.ts` is bundled at runtime with esbuild and executed twice:
 *
 *   1. CONTROL — a deliberately junk key must be REJECTED (401/403). If the harness
 *      accepted it, the "VALID" verdict below would prove nothing.
 *   2. SUBJECT  — the real key must be VALID: a 2xx chat probe, or a "Not found for
 *      account" 404, which is only reachable once authentication already succeeded.
 *
 * Key resolution order: `NVIDIA_API_KEY` env var, then `./.env`, then `./.nvidia-key`.
 * The key itself is NEVER printed — not on success, not on failure, not in errors.
 *
 * Exit 0 when both checks behave as expected, exit 1 otherwise.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE_URL = (process.env.VIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1').trim()
/** Bogus, but shaped like a real `nvapi-…` key so the endpoint rejects it with 401/403. */
const JUNK_KEY = 'nvapi-key-check-control-000000000000'

const pass = (msg) => console.log(`ok   ${msg}`)
const fail = (msg) => console.error(`FAIL ${msg}`)

/** Strips one layer of quoting from a `.env` value (`"…"` or `…`). */
const unquote = (value) => value.trim().replace(/^["']|["']$/g, '')

/**
 * Resolves the key to verify without ever logging it.
 * Returns `{ key, source }` or `{ key: undefined, source: undefined }`.
 */
function resolveKey() {
  const fromEnv = process.env.NVIDIA_API_KEY?.trim()
  if (fromEnv) return { key: fromEnv, source: 'NVIDIA_API_KEY env var' }

  for (const file of ['.env', '.nvidia-key']) {
    let raw
    try {
      raw = readFileSync(join(ROOT, file), 'utf8')
    } catch {
      continue // file absent — try the next source
    }
    const lines = raw.split(/\r?\n/).filter(l => l.trim() !== '' && !l.trim().startsWith('#'))
    if (lines.length === 0) continue
    // `.env` may hold unrelated variables, so prefer an explicit key line; a bare
    // `.nvidia-key` file contains only the key itself.
    const assignment = lines.find(l => /^\s*(NVIDIA_API_KEY|NVAPI_KEY)\s*=/.test(l))
    const value = assignment ? unquote(assignment.slice(assignment.indexOf('=') + 1)) : unquote(lines[0])
    if (value) return { key: value, source: `./${file}` }
  }
  return { key: undefined, source: undefined }
}

/** Bundles the vscode-free verdict module so the exact production code path runs here. */
async function loadKeyVerifier() {
  const dir = mkdtempSync(join(tmpdir(), 'vidia-key-check-'))
  const outfile = join(dir, 'keyVerifier.mjs')
  try {
    await build({
      entryPoints: [join(ROOT, 'src', 'keyVerifier.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      outfile,
      logLevel: 'silent'
    })
    return await import(pathToFileURL(outfile).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** True when `err` is the definitive "this key was refused" verdict (401/403). */
const isRejected = (err) => err?.status === 401 || err?.status === 403

async function main() {
  console.log(`NVIDIA key check against ${BASE_URL}\n`)

  const { checkKey, NvidiaApiError } = await loadKeyVerifier()

  // 1. CONTROL: a junk key must be rejected, otherwise a "VALID" verdict means nothing.
  try {
    await checkKey(BASE_URL, JUNK_KEY)
    fail('control: junk key was ACCEPTED — the verifier cannot prove anything.')
    process.exitCode = 1
  } catch (err) {
    if (isRejected(err)) pass('control: junk key rejected (401/403) as expected')
    else {
      const status = err instanceof NvidiaApiError ? err.status : 'transport error'
      fail(`control: expected rejection with 401/403, got ${status} — inconclusive, try again.`)
      process.exitCode = 1
    }
  }

  // 2. SUBJECT: the real key must be proven good.
  const { key, source } = resolveKey()
  if (!key) {
    fail('no API key found. Set NVIDIA_API_KEY, or create ./.env / ./.nvidia-key.')
    process.exitCode = 1
    return
  }
  console.log(`using key from ${source} (value not shown)`)

  try {
    const { models, probes } = await checkKey(BASE_URL, key)
    pass(`subject: key VALID — ${probes} probe(s), ${models.length} model(s) in catalog`)
  } catch (err) {
    if (isRejected(err)) fail('subject: real key was REJECTED (401/403). Is it expired or mistyped?')
    else {
      const detail = err instanceof Error ? err.message : String(err)
      fail(`subject: could not verify the key — ${detail}`)
    }
    process.exitCode = 1
  }

  console.log(process.exitCode ? '\nRESULT: FAILED' : '\nRESULT: PASSED')
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
