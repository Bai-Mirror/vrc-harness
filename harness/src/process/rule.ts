/**
 * Closed-form check rules, e.g. `abs(head_foot_y_delta_mm) <= t.skeleton_height_max_delta_mm and animator_is_human == true`.
 *
 * Grammar (Python-like, what compiled SOP rules use): `or` < `and` < `not` < chained comparisons
 * (`a <= b <= c`) < `+ -` < `* /` < unary `-` < numbers, `true`/`false`, metric names, `t.<threshold>`,
 * `abs(x)`, parentheses.
 *
 * Missing data never passes. A metric that the observer did not report (absent or null) is unknown, and
 * logic is three-valued (Kleene): `true or unknown` is true, `false and unknown` is false, anything else
 * touching unknown stays unknown and the check records `no_data`. Type errors record `error`.
 */
export type RuleValue = number | boolean;
type Node =
  | { type: 'num'; value: number } | { type: 'bool'; value: boolean }
  | { type: 'metric'; name: string } | { type: 'threshold'; name: string }
  | { type: 'unary'; op: '-' | 'not'; arg: Node }
  | { type: 'binary'; op: '+' | '-' | '*' | '/'; left: Node; right: Node }
  | { type: 'logic'; op: 'and' | 'or'; left: Node; right: Node }
  | { type: 'compare'; ops: CompareOp[]; args: Node[] }
  | { type: 'call'; name: 'abs'; arg: Node };
type CompareOp = '<' | '<=' | '>' | '>=' | '==' | '!=';
const UNKNOWN = Symbol('unknown');
type Value = RuleValue | typeof UNKNOWN;

export interface ParsedRule { source: string; ast: Node; metrics: string[]; thresholds: string[] }
export interface RuleOutcome {
  result: 'pass' | 'violation' | 'no_data' | 'error';
  /** Metrics the rule referenced that the observation did not report. */
  missing: string[];
  /** Values read while evaluating, for the Verdict basis. */
  used: Record<string, RuleValue | null>;
  message?: string;
}

class RuleError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)|(<=|>=|==|!=|[<>+\-*/(),]))/y;
  let index = 0;
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break;
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) throw new RuleError(`无法识别的字符: ${source.slice(index).trimStart().slice(0, 12)}`);
    tokens.push(match[1] ?? match[2] ?? match[3]!);
    index = pattern.lastIndex;
  }
  return tokens;
}

export function parseRule(source: string): ParsedRule {
  const tokens = tokenize(source);
  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const take = (expected?: string): string => {
    const token = tokens[position];
    if (token === undefined || (expected !== undefined && token !== expected))
      throw new RuleError(`期望 ${expected ?? '表达式'}，遇到 ${token ?? '结尾'}`);
    position++;
    return token;
  };
  const metrics = new Set<string>(); const thresholds = new Set<string>();

  function or(): Node { let node = and(); while (peek() === 'or') { take(); node = { type: 'logic', op: 'or', left: node, right: and() }; } return node; }
  function and(): Node { let node = not(); while (peek() === 'and') { take(); node = { type: 'logic', op: 'and', left: node, right: not() }; } return node; }
  function not(): Node { if (peek() === 'not') { take(); return { type: 'unary', op: 'not', arg: not() }; } return compare(); }
  function compare(): Node {
    const args = [additive()]; const ops: CompareOp[] = [];
    while (['<', '<=', '>', '>=', '==', '!='].includes(peek() ?? '')) { ops.push(take() as CompareOp); args.push(additive()); }
    return ops.length ? { type: 'compare', ops, args } : args[0]!;
  }
  function additive(): Node {
    let node = multiplicative();
    while (peek() === '+' || peek() === '-') { const op = take() as '+' | '-'; node = { type: 'binary', op, left: node, right: multiplicative() }; }
    return node;
  }
  function multiplicative(): Node {
    let node = unary();
    while (peek() === '*' || peek() === '/') { const op = take() as '*' | '/'; node = { type: 'binary', op, left: node, right: unary() }; }
    return node;
  }
  function unary(): Node { if (peek() === '-') { take(); return { type: 'unary', op: '-', arg: unary() }; } return primary(); }
  function primary(): Node {
    const token = take();
    if (token === '(') { const node = or(); take(')'); return node; }
    if (/^\d/.test(token)) return { type: 'num', value: Number(token) };
    if (token === 'true' || token === 'false') return { type: 'bool', value: token === 'true' };
    if (token === 'abs') { take('('); const arg = or(); take(')'); return { type: 'call', name: 'abs', arg }; }
    if (['and', 'or', 'not'].includes(token) || !/^[A-Za-z_]/.test(token)) throw new RuleError(`此处不能是 ${token}`);
    if (token.startsWith('t.')) { thresholds.add(token.slice(2)); return { type: 'threshold', name: token.slice(2) }; }
    if (token.includes('.')) throw new RuleError(`指标名不能含点: ${token}`);
    metrics.add(token);
    return { type: 'metric', name: token };
  }
  if (!tokens.length) throw new RuleError('规则为空');
  const ast = or();
  if (position !== tokens.length) throw new RuleError(`多余的内容: ${tokens.slice(position).join(' ')}`);
  return { source, ast, metrics: [...metrics], thresholds: [...thresholds] };
}

/** Parse errors surface with the rule text so a broken definition is diagnosable. */
export function tryParseRule(source: string): { rule?: ParsedRule; error?: string } {
  try { return { rule: parseRule(source) }; }
  catch (error) { return { error: `rule ${JSON.stringify(source)}: ${(error as Error).message}` }; }
}

export function evaluateRule(rule: ParsedRule, metrics: Record<string, unknown>,
  thresholds: Record<string, RuleValue>): RuleOutcome {
  const used: Record<string, RuleValue | null> = {}; const missing = new Set<string>();
  const number = (value: RuleValue, what: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new RuleError(`${what} 需要数值，得到 ${JSON.stringify(value)}`);
    return value;
  };
  const truth = (value: Value, what: string): boolean | typeof UNKNOWN => {
    if (value === UNKNOWN) return UNKNOWN;
    if (typeof value !== 'boolean') throw new RuleError(`${what} 需要真假值，得到 ${JSON.stringify(value)}`);
    return value;
  };
  function evaluate(node: Node): Value {
    switch (node.type) {
      case 'num': case 'bool': return node.value;
      case 'metric': {
        const raw = Object.hasOwn(metrics, node.name) ? metrics[node.name] : undefined;
        if (raw === undefined || raw === null) { missing.add(node.name); used[node.name] = null; return UNKNOWN; }
        if (typeof raw !== 'number' && typeof raw !== 'boolean') throw new RuleError(`指标 ${node.name} 不是数值或真假值`);
        used[node.name] = raw;
        return raw;
      }
      case 'threshold': {
        if (!Object.hasOwn(thresholds, node.name)) throw new RuleError(`未知阈值 t.${node.name}`);
        used[`t.${node.name}`] = thresholds[node.name]!;
        return thresholds[node.name]!;
      }
      case 'call': { const value = evaluate(node.arg); return value === UNKNOWN ? UNKNOWN : Math.abs(number(value, 'abs()')); }
      case 'unary': {
        const value = evaluate(node.arg);
        if (value === UNKNOWN) return UNKNOWN;
        return node.op === '-' ? -number(value, '取负') : !truth(value, 'not');
      }
      case 'binary': {
        const left = evaluate(node.left), right = evaluate(node.right);
        if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
        const a = number(left, node.op), b = number(right, node.op);
        if (node.op === '/' && b === 0) throw new RuleError('除以零');
        return node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : a / b;
      }
      case 'logic': {
        const left = truth(evaluate(node.left), node.op);
        if (node.op === 'or' && left === true) return true;
        if (node.op === 'and' && left === false) return false;
        const right = truth(evaluate(node.right), node.op);
        if (node.op === 'or') return right === true ? true : left === UNKNOWN || right === UNKNOWN ? UNKNOWN : false;
        return right === false ? false : left === UNKNOWN || right === UNKNOWN ? UNKNOWN : true;
      }
      case 'compare': {
        const values = node.args.map(evaluate);
        let result: boolean | typeof UNKNOWN = true;
        for (let i = 0; i < node.ops.length; i++) {
          const a = values[i]!, b = values[i + 1]!, op = node.ops[i]!;
          let holds: boolean | typeof UNKNOWN;
          if (a === UNKNOWN || b === UNKNOWN) holds = UNKNOWN;
          else if (op === '==' || op === '!=') {
            if (typeof a !== typeof b) throw new RuleError(`不能比较 ${JSON.stringify(a)} 与 ${JSON.stringify(b)}`);
            holds = op === '==' ? a === b : a !== b;
          } else {
            const x = number(a, op), y = number(b, op);
            holds = op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
          }
          if (holds === false) return false;
          if (holds === UNKNOWN) result = UNKNOWN;
        }
        return result;
      }
    }
  }
  try {
    const value = evaluate(rule.ast);
    if (value === UNKNOWN) return { result: 'no_data', missing: [...missing], used, message: `缺少指标: ${[...missing].join(', ')}` };
    if (typeof value !== 'boolean') return { result: 'error', missing: [...missing], used, message: `规则结果不是真假值: ${value}` };
    return { result: value ? 'pass' : 'violation', missing: [...missing], used };
  } catch (error) {
    return { result: 'error', missing: [...missing], used, message: (error as Error).message };
  }
}
