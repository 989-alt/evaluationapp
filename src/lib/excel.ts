import * as XLSX from 'xlsx'

export function downloadXlsx(fileName: string, sheets: Array<{ name: string; rows: Array<Record<string, string | number>> }>) {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = XLSX.utils.json_to_sheet(s.rows)
    const cols = Object.keys(s.rows[0] ?? {})
    ws['!cols'] = cols.map((c) => ({ wch: /평어|내용|문장|의견|특기/.test(c) ? 80 : 12 }))
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31))
  }
  XLSX.writeFile(wb, fileName)
}

/** 시트 이름 규칙(31자, 금지 문자 : \ / ? * [ ])에 맞추고 `used`와 겹치지 않게 번호를 붙입니다 */
export function uniqueSheetName(name: string, used: Set<string>, fallback = '시트') {
  const base = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 28).replace(/^'+|'+$/g, '').trim() || fallback
  let n = base
  for (let i = 2; used.has(n); i++) n = `${base} ${i}`
  used.add(n)
  return n
}

export async function readXlsxRows(file: File): Promise<string[][]> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '' })
}
