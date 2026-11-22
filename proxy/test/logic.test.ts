import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetKeys, costOf, kstPeriods, LIMITS, MAX_TOKENS, MODEL, sanitize } from '../src/logic.ts'

test('KST 기준 날짜: UTC 15시는 다음 날', () => {
  assert.deepEqual(kstPeriods(new Date('2026-11-30T15:00:00Z')), { day: '2026-12-01', month: '2026-12' })
  assert.deepEqual(kstPeriods(new Date('2026-11-30T14:59:59Z')), { day: '2026-11-30', month: '2026-11' })
})

test('한도 키 5개와 값', () => {
  const k = budgetKeys('dev-aaaaaaaaaaaaaaaa', 'ip1', new Date('2026-11-22T03:00:00Z'))
  assert.deepEqual(k.map((x) => [x.key, x.limit]), [
    ['m:2026-11', 150], ['d:2026-11-22', 11], ['dd:dev-aaaaaaaaaaaaaaaa:2026-11-22', 1], ['dm:dev-aaaaaaaaaaaaaaaa:2026-11', 2.5], ['id:ip1:2026-11-22', 5],
  ])
  assert.equal(LIMITS.month, 150)
})

test('비용: Sonnet 단가, 음수·누락 무시', () => {
  assert.equal(costOf({ input_tokens: 1_000_000, output_tokens: 100_000 }), 3)
  assert.equal(costOf({ input_tokens: -5, output_tokens: 'x' }), 0)
  assert.equal(costOf(undefined), 0)
})

test('sanitize: 모델·thinking 강제, max_tokens 상한, 다른 필드 버림', () => {
  const r = sanitize({ model: 'claude-opus-5-5', max_tokens: 999999, temperature: 1, tools: [{}], system: 's', messages: [{ role: 'user', content: 'hi' }] })
  assert.ok(r.ok)
  if (r.ok) assert.deepEqual(r.body, { model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'between_tools' }, system: 's' })
  assert.equal(sanitize({ messages: [] }).ok, false)
  assert.equal(sanitize({ messages: [{}], stream: true }).ok, false)
  assert.equal(sanitize(null).ok, false)
})
