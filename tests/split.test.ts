import test from 'node:test'
import assert from 'node:assert/strict'
import { behaviorTokens, creativeTokens, runSplitting, splitByCount } from '../src/lib/split.ts'

const truncated = () => Object.assign(new Error('잘림'), { truncated: true })

test('잘리지 않으면 한 번만 부른다', async () => {
  const calls: number[][] = []
  const out = await runSplitting([1, 2, 3], async (g) => (calls.push(g), g.map((x) => x * 10)))
  assert.deepEqual(calls, [[1, 2, 3]])
  assert.deepEqual(out, [10, 20, 30])
})

test('잘리면 반으로 나눠 다시 부르고 결과를 순서대로 합친다', async () => {
  const calls: number[][] = []
  const splits: number[] = []
  const out = await runSplitting(
    [1, 2, 3, 4, 5],
    async (g) => {
      calls.push(g)
      if (g.length > 2) throw truncated()
      return g.map((x) => x * 10)
    },
    { onSplit: (g) => void splits.push(g.length) },
  )
  assert.deepEqual(calls, [[1, 2, 3, 4, 5], [1, 2, 3], [1, 2], [3], [4, 5]])
  assert.deepEqual(splits, [5, 3])
  assert.deepEqual(out, [10, 20, 30, 40, 50])
})

test('1명인데도 잘리면 오류를 그대로 던진다', async () => {
  await assert.rejects(runSplitting([1], async () => { throw truncated() }), /잘림/)
})

test('잘림이 아닌 오류는 나누지 않는다', async () => {
  const calls: number[][] = []
  await assert.rejects(runSplitting([1, 2, 3], async (g) => { calls.push(g); throw new Error('서버 오류') }), /서버 오류/)
  assert.equal(calls.length, 1)
})

test('splitByCount: 여러 개면 반으로, 1개면 개수를 반으로, 개수 1이면 못 나눈다', () => {
  const a = { text: 'a', count: 5 }
  const b = { text: 'b', count: 3 }
  assert.deepEqual(splitByCount([a, b]), [[a], [b]])
  assert.deepEqual(splitByCount([a]), [[{ text: 'a', count: 3 }], [{ text: 'a', count: 2 }]])
  assert.equal(splitByCount([{ text: 'a', count: 1 }]), null)
})

test('개수를 반으로 나눈 창체 요청도 끝까지 이어 가서 합친다', async () => {
  const out = await runSplitting(
    [{ text: 'a', count: 20 }],
    async (g) => {
      if (g[0].count > 6) throw truncated()
      return Array.from({ length: g[0].count }, (_, i) => `${g[0].count}-${i}`)
    },
    { split: splitByCount },
  )
  assert.equal(out.length, 20)
})

test('출력 상한은 학생 수·목표 바이트에 비례하고 공급자 한도(16000) 안이다', () => {
  assert.ok(behaviorTokens(3, 700) > behaviorTokens(1, 700))
  assert.ok(behaviorTokens(3, 1500) > behaviorTokens(3, 700))
  assert.ok(behaviorTokens(5, 700) >= 8000) // 예전 고정값보다 작지 않다
  assert.equal(behaviorTokens(60, 3000), 16000)
  const t = creativeTokens([{ text: '학급 회의에서 의견을 정리하여 발표함.', count: 20 }])
  assert.ok(t > 8000 && t <= 16000)
})
