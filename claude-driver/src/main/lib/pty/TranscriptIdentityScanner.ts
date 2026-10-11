/** Extract only a top-level sessionId from completed JSONL objects, without retaining message bodies. */
export class TranscriptIdentityScanner {
  private depth = 0
  private inString = false
  private escaped = false
  private token = ''
  private capture = false
  private key = ''
  private state: 'key' | 'colon' | 'value' | 'delimiter' = 'key'
  private candidate: string | undefined
  private invalid = false
  private opened = false

  push(chunk: string, expected: string): 'ready' | 'waiting' | 'conflict' {
    let conflict = false
    for (const char of chunk) {
      if (this.inString) {
        // A literal newline inside a JSON string is malformed; recover at the next record.
        if (char === '\n') { this.reset(); continue }
        if (this.capture && this.token.length <= 64) this.token += char
        if (this.escaped) { this.escaped = false; continue }
        if (char === '\\') { this.escaped = true; continue }
        if (char === '"') {
          this.inString = false
          if (this.depth === 1) {
            if (this.state === 'key') {
              try { this.key = JSON.parse(this.token) as string } catch { this.key = '' }
              this.state = 'colon'
            } else if (this.state === 'value') {
              if (this.key === 'sessionId') {
                try { this.candidate = JSON.parse(this.token) as string } catch { this.invalid = true }
              }
              this.state = 'delimiter'
            }
          }
        }
        continue
      }
      if (char === '\n') {
        const id = !this.invalid && this.opened && this.depth === 0 ? this.candidate : undefined
        this.reset()
        if (id === expected) return 'ready'
        if (id) conflict = true
        continue
      }
      if (/\s/.test(char)) continue
      if (char === '"') {
        this.inString = true
        this.capture = this.depth === 1 && (this.state === 'key' || (this.state === 'value' && this.key === 'sessionId'))
        this.token = this.capture ? '"' : ''
      } else if (char === '{' || char === '[') {
        if (this.depth === 0) {
          if (this.opened || char !== '{') this.invalid = true
          this.opened = true
        } else if (this.depth === 1) this.state = 'delimiter'
        this.depth++
      } else if (char === '}' || char === ']') {
        this.depth--
        if (this.depth < 0) this.invalid = true
      } else if (this.depth === 1 && char === ':') this.state = 'value'
      else if (this.depth === 1 && char === ',') { this.state = 'key'; this.key = '' }
      else if (this.depth === 0) this.invalid = true
    }
    return conflict ? 'conflict' : 'waiting'
  }

  reset(): void {
    this.depth = 0
    this.inString = false
    this.escaped = false
    this.token = ''
    this.key = ''
    this.candidate = undefined
    this.state = 'key'
    this.invalid = false
    this.opened = false
  }
}
