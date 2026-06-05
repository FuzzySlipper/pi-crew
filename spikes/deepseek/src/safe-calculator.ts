/* eslint-disable @typescript-eslint/no-unnecessary-condition */
/** Safe arithmetic evaluator for the DeepSeek tool-calling spike. */
export function calculate(expression: string): string {
  try {
    const parser = new ArithmeticParser(expression);
    const value = parser.parse();
    return String(value);
  } catch (error: unknown) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

class ArithmeticParser {
  private index = 0;

  constructor(private readonly input: string) {}

  parse(): number {
    const value = this.parseExpression();
    this.skipWhitespace();
    if (this.index !== this.input.length) {
      throw new Error(`unexpected token '${this.input[this.index] ?? ""}'`);
    }
    return value;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      this.skipWhitespace();
      if (this.consume("+")) {
        value += this.parseTerm();
      } else if (this.consume("-")) {
        value -= this.parseTerm();
      } else {
        return value;
      }
    }
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    while (true) {
      this.skipWhitespace();
      if (this.consume("*")) {
        value *= this.parseFactor();
      } else if (this.consume("/")) {
        value /= this.parseFactor();
      } else if (this.consume("%")) {
        value %= this.parseFactor();
      } else {
        return value;
      }
    }
  }

  private parseFactor(): number {
    this.skipWhitespace();
    if (this.consume("(")) {
      const value = this.parseExpression();
      if (!this.consume(")")) {
        throw new Error("expected ')'");
      }
      return value;
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const start = this.index;
    if (this.peek() === "-") {
      this.index += 1;
    }
    while (/[0-9.]/u.test(this.peek())) {
      this.index += 1;
    }
    const text = this.input.slice(start, this.index);
    const value = Number(text);
    if (!text || Number.isNaN(value)) {
      throw new Error(`expected number at offset ${String(start)}`);
    }
    return value;
  }

  private consume(token: string): boolean {
    this.skipWhitespace();
    if (this.input.startsWith(token, this.index)) {
      this.index += token.length;
      return true;
    }
    return false;
  }

  private peek(): string {
    return this.input[this.index] ?? "";
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.peek())) {
      this.index += 1;
    }
  }
}
