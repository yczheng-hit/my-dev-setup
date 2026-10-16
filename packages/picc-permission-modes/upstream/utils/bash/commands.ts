import { randomBytes } from 'crypto'
import type { ControlOperator, ParseEntry } from 'shell-quote'
import type {
  CommandPrefixResult,
  CommandSubcommandPrefixResult,
} from '../../_compat/stubs.ts'
import { extractHeredocs, restoreHeredocs } from './heredoc.ts'
import { quote, tryParseShellCommand } from './shellQuote.ts'
type CreateCommandPrefixExtractorConfig = never
type CreateSubcommandPrefixExtractorConfig = never
export function createCommandPrefixExtractor(
  _config: CreateCommandPrefixExtractorConfig,
): never {
  throw new Error(
    'createCommandPrefixExtractor: LLM-prefix extraction is not supported in pi; ' +
      'pi security paths do not call this function.',
  )
}
export function createSubcommandPrefixExtractor(
  _getPrefix: never,
  _splitCommand: (cmd: string) => string[] | Promise<string[]>,
): never {
  throw new Error(
    'createSubcommandPrefixExtractor: LLM-prefix extraction is not supported in pi; ' +
      'pi security paths do not call this function.',
  )
}
function generatePlaceholders(): {
  SINGLE_QUOTE: string
  DOUBLE_QUOTE: string
  NEW_LINE: string
  ESCAPED_OPEN_PAREN: string
  ESCAPED_CLOSE_PAREN: string
} {
  const salt = randomBytes(8).toString('hex')
  return {
    SINGLE_QUOTE: `__SINGLE_QUOTE_${salt}__`,
    DOUBLE_QUOTE: `__DOUBLE_QUOTE_${salt}__`,
    NEW_LINE: `__NEW_LINE_${salt}__`,
    ESCAPED_OPEN_PAREN: `__ESCAPED_OPEN_PAREN_${salt}__`,
    ESCAPED_CLOSE_PAREN: `__ESCAPED_CLOSE_PAREN_${salt}__`,
  }
}
const ALLOWED_FILE_DESCRIPTORS = new Set(['0', '1', '2'])
function isStaticRedirectTarget(target: string): boolean {
  if (/[\s'"]/.test(target)) return false
  if (target.length === 0) return false
  if (target.startsWith('#')) return false
  return (
    !target.startsWith('!') &&
    !target.startsWith('=') &&
    !target.includes('$') &&
    !target.includes('`') &&
    !target.includes('*') &&
    !target.includes('?') &&
    !target.includes('[') &&
    !target.includes('{') &&
    !target.includes('~') &&
    !target.includes('(') &&
    !target.includes('<') &&
    !target.startsWith('&')
  )
}
export type { CommandPrefixResult, CommandSubcommandPrefixResult }
export function splitCommandWithOperators(command: string): string[] {
  const parts: (ParseEntry | null)[] = []
  const placeholders = generatePlaceholders()
  const { processedCommand, heredocs } = extractHeredocs(command)
  const commandWithContinuationsJoined = processedCommand.replace(
    /\\+\n/g,
    match => {
      const backslashCount = match.length - 1
      if (backslashCount % 2 === 1) {
        return '\\'.repeat(backslashCount - 1)
      } else {
        return match
      }
    },
  )
  const commandOriginalJoined = command.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1
    if (backslashCount % 2 === 1) {
      return '\\'.repeat(backslashCount - 1)
    }
    return match
  })
  const parseResult = tryParseShellCommand(
    commandWithContinuationsJoined
      .replaceAll('"', `"${placeholders.DOUBLE_QUOTE}`)
      .replaceAll("'", `'${placeholders.SINGLE_QUOTE}`)
      .replaceAll('\n', `\n${placeholders.NEW_LINE}\n`)
      .replaceAll('\\(', placeholders.ESCAPED_OPEN_PAREN)
      .replaceAll('\\)', placeholders.ESCAPED_CLOSE_PAREN),
    varName => `$${varName}`,
  )
  if (!parseResult.success) {
    return [commandOriginalJoined]
  }
  const parsed = parseResult.tokens
  if (parsed.length === 0) {
    return []
  }
  try {
    for (const part of parsed) {
      if (typeof part === 'string') {
        if (parts.length > 0 && typeof parts[parts.length - 1] === 'string') {
          if (part === placeholders.NEW_LINE) {
            parts.push(null)
          } else {
            parts[parts.length - 1] += ' ' + part
          }
          continue
        }
      } else if ('op' in part && part.op === 'glob') {
        if (parts.length > 0 && typeof parts[parts.length - 1] === 'string') {
          parts[parts.length - 1] += ' ' + part.pattern
          continue
        }
      }
      parts.push(part)
    }
    const stringParts = parts
      .map(part => {
        if (part === null) {
          return null
        }
        if (typeof part === 'string') {
          return part
        }
        if ('comment' in part) {
          const cleaned = part.comment
            .replaceAll(
              `"${placeholders.DOUBLE_QUOTE}`,
              placeholders.DOUBLE_QUOTE,
            )
            .replaceAll(
              `'${placeholders.SINGLE_QUOTE}`,
              placeholders.SINGLE_QUOTE,
            )
          return '#' + cleaned
        }
        if ('op' in part && part.op === 'glob') {
          return part.pattern
        }
        if ('op' in part) {
          return part.op
        }
        return null
      })
      .filter(_ => _ !== null)
    const quotedParts = stringParts.map(part => {
      return part
        .replaceAll(`${placeholders.SINGLE_QUOTE}`, "'")
        .replaceAll(`${placeholders.DOUBLE_QUOTE}`, '"')
        .replaceAll(`\n${placeholders.NEW_LINE}\n`, '\n')
        .replaceAll(placeholders.ESCAPED_OPEN_PAREN, '\\(')
        .replaceAll(placeholders.ESCAPED_CLOSE_PAREN, '\\)')
    })
    return restoreHeredocs(quotedParts, heredocs)
  } catch (_error) {
    return [commandOriginalJoined]
  }
}
export function filterControlOperators(
  commandsAndOperators: string[],
): string[] {
  return commandsAndOperators.filter(
    part => !(ALL_SUPPORTED_CONTROL_OPERATORS as unknown as Set<string>).has(part),
  )
}
export function splitCommand_DEPRECATED(command: string): string[] {
  const parts: (string | undefined)[] = splitCommandWithOperators(command)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined) {
      continue
    }
    if (part === '>&' || part === '>' || part === '>>') {
      const prevPart = parts[i - 1]?.trim()
      const nextPart = parts[i + 1]?.trim()
      const afterNextPart = parts[i + 2]?.trim()
      if (nextPart === undefined) {
        continue
      }
      let shouldStrip = false
      let stripThirdToken = false
      let effectiveNextPart = nextPart
      if (
        (part === '>' || part === '>>') &&
        nextPart.length >= 3 &&
        nextPart.charAt(nextPart.length - 2) === ' ' &&
        ALLOWED_FILE_DESCRIPTORS.has(nextPart.charAt(nextPart.length - 1)) &&
        (afterNextPart === '>' ||
          afterNextPart === '>>' ||
          afterNextPart === '>&')
      ) {
        effectiveNextPart = nextPart.slice(0, -2)
      }
      if (part === '>&' && ALLOWED_FILE_DESCRIPTORS.has(nextPart)) {
        shouldStrip = true
      } else if (
        part === '>' &&
        nextPart === '&' &&
        afterNextPart !== undefined &&
        ALLOWED_FILE_DESCRIPTORS.has(afterNextPart)
      ) {
        shouldStrip = true
        stripThirdToken = true
      } else if (
        part === '>' &&
        nextPart.startsWith('&') &&
        nextPart.length > 1 &&
        ALLOWED_FILE_DESCRIPTORS.has(nextPart.slice(1))
      ) {
        shouldStrip = true
      } else if (
        (part === '>' || part === '>>') &&
        isStaticRedirectTarget(effectiveNextPart)
      ) {
        shouldStrip = true
      }
      if (shouldStrip) {
        if (
          prevPart &&
          prevPart.length >= 3 &&
          ALLOWED_FILE_DESCRIPTORS.has(prevPart.charAt(prevPart.length - 1)) &&
          prevPart.charAt(prevPart.length - 2) === ' '
        ) {
          parts[i - 1] = prevPart.slice(0, -2)
        }
        parts[i] = undefined
        parts[i + 1] = undefined
        if (stripThirdToken) {
          parts[i + 2] = undefined
        }
      }
    }
  }
  const stringParts = parts.filter(
    (part): part is string => part !== undefined && part !== '',
  )
  return filterControlOperators(stringParts)
}
export function isHelpCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed.endsWith('--help')) {
    return false
  }
  if (trimmed.includes('"') || trimmed.includes("'")) {
    return false
  }
  const parseResult = tryParseShellCommand(trimmed)
  if (!parseResult.success) {
    return false
  }
  const tokens = parseResult.tokens
  let foundHelp = false
  const alphanumericPattern = /^[a-zA-Z0-9]+$/
  for (const token of tokens) {
    if (typeof token === 'string') {
      if (token.startsWith('-')) {
        if (token === '--help') {
          foundHelp = true
        } else {
          return false
        }
      } else {
        if (!alphanumericPattern.test(token)) {
          return false
        }
      }
    }
  }
  return foundHelp
}
export function getCommandSubcommandPrefix(): never {
  throw new Error(
    'getCommandSubcommandPrefix: LLM-prefix extraction is not supported in pi.',
  )
}
export function clearCommandPrefixCaches(): void {
}
const COMMAND_LIST_SEPARATORS = new Set<ControlOperator>(
  ['&&', '||', ';', ';;', '|'] as unknown as ControlOperator[],
)
const ALL_SUPPORTED_CONTROL_OPERATORS = new Set<ControlOperator>(
  [...COMMAND_LIST_SEPARATORS, '>&', '>', '>>'] as unknown as ControlOperator[],
)
function isCommandList(command: string): boolean {
  const placeholders = generatePlaceholders()
  const { processedCommand } = extractHeredocs(command)
  const parseResult = tryParseShellCommand(
    processedCommand
      .replaceAll('"', `"${placeholders.DOUBLE_QUOTE}`)
      .replaceAll("'", `'${placeholders.SINGLE_QUOTE}`),
    varName => `$${varName}`,
  )
  if (!parseResult.success) {
    return false
  }
  const parts = parseResult.tokens
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const nextPart = parts[i + 1]
    if (part === undefined) {
      continue
    }
    if (typeof part === 'string') {
      continue
    }
    if ('comment' in part) {
      return false
    }
    if ('op' in part) {
      if (part.op === 'glob') {
        continue
      } else if (COMMAND_LIST_SEPARATORS.has(part.op as unknown as ControlOperator)) {
        continue
      } else if (part.op === '>&') {
        if (
          nextPart !== undefined &&
          typeof nextPart === 'string' &&
          ALLOWED_FILE_DESCRIPTORS.has(nextPart.trim())
        ) {
          continue
        }
      } else if (part.op === '>') {
        continue
      } else if (part.op === '>>') {
        continue
      }
      return false
    }
  }
  return true
}
export function isUnsafeCompoundCommand_DEPRECATED(command: string): boolean {
  const { processedCommand } = extractHeredocs(command)
  const parseResult = tryParseShellCommand(
    processedCommand,
    varName => `$${varName}`,
  )
  if (!parseResult.success) {
    return true
  }
  return splitCommand_DEPRECATED(command).length > 1 && !isCommandList(command)
}
export function extractOutputRedirections(cmd: string): {
  commandWithoutRedirections: string
  redirections: Array<{ target: string; operator: '>' | '>>' }>
  hasDangerousRedirection: boolean
} {
  const redirections: Array<{ target: string; operator: '>' | '>>' }> = []
  let hasDangerousRedirection = false
  const { processedCommand: heredocExtracted, heredocs } = extractHeredocs(cmd)
  const processedCommand = heredocExtracted.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1
    if (backslashCount % 2 === 1) {
      return '\\'.repeat(backslashCount - 1)
    }
    return match
  })
  const parseResult = tryParseShellCommand(processedCommand, env => `$${env}`)
  if (!parseResult.success) {
    return {
      commandWithoutRedirections: cmd,
      redirections: [],
      hasDangerousRedirection: true,
    }
  }
  const parsed = parseResult.tokens
  const redirectedSubshells = new Set<number>()
  const parenStack: Array<{ index: number; isStart: boolean }> = []
  parsed.forEach((part, i) => {
    if (isOperator(part, '(')) {
      const prev = parsed[i - 1]
      const isStart =
        i === 0 ||
        (prev &&
          typeof prev === 'object' &&
          'op' in prev &&
          ['&&', '||', ';', '|'].includes(prev.op))
      parenStack.push({ index: i, isStart: !!isStart })
    } else if (isOperator(part, ')') && parenStack.length > 0) {
      const opening = parenStack.pop()!
      const next = parsed[i + 1]
      if (
        opening.isStart &&
        (isOperator(next, '>') || isOperator(next, '>>'))
      ) {
        redirectedSubshells.add(opening.index).add(i)
      }
    }
  })
  const kept: ParseEntry[] = []
  let cmdSubDepth = 0
  for (let i = 0; i < parsed.length; i++) {
    const part = parsed[i]
    if (!part) continue
    const [prev, next] = [parsed[i - 1], parsed[i + 1]]
    if (
      (isOperator(part, '(') || isOperator(part, ')')) &&
      redirectedSubshells.has(i)
    ) {
      continue
    }
    if (
      isOperator(part, '(') &&
      prev &&
      typeof prev === 'string' &&
      prev.endsWith('$')
    ) {
      cmdSubDepth++
    } else if (isOperator(part, ')') && cmdSubDepth > 0) {
      cmdSubDepth--
    }
    if (cmdSubDepth === 0) {
      const { skip, dangerous } = handleRedirection(
        part,
        prev,
        next,
        parsed[i + 2],
        parsed[i + 3],
        redirections,
        kept,
      )
      if (dangerous) {
        hasDangerousRedirection = true
      }
      if (skip > 0) {
        i += skip
        continue
      }
    }
    kept.push(part)
  }
  return {
    commandWithoutRedirections: restoreHeredocs(
      [reconstructCommand(kept, processedCommand)],
      heredocs,
    )[0]!,
    redirections,
    hasDangerousRedirection,
  }
}
function isOperator(part: ParseEntry | undefined, op: string): boolean {
  return (
    typeof part === 'object' && part !== null && 'op' in part && part.op === op
  )
}
function isSimpleTarget(target: ParseEntry | undefined): target is string {
  if (typeof target !== 'string' || target.length === 0) return false
  return (
    !target.startsWith('!') &&
    !target.startsWith('=') &&
    !target.startsWith('~') &&
    !target.includes('$') &&
    !target.includes('`') &&
    !target.includes('*') &&
    !target.includes('?') &&
    !target.includes('[') &&
    !target.includes('{')
  )
}
function hasDangerousExpansion(target: ParseEntry | undefined): boolean {
  if (typeof target === 'object' && target !== null && 'op' in target) {
    if (target.op === 'glob') return true
    return false
  }
  if (typeof target !== 'string') return false
  if (target.length === 0) return false
  return (
    target.includes('$') ||
    target.includes('%') ||
    target.includes('`') ||
    target.includes('*') ||
    target.includes('?') ||
    target.includes('[') ||
    target.includes('{') ||
    target.startsWith('!') ||
    target.startsWith('=') ||
    target.startsWith('~')
  )
}
function handleRedirection(
  part: ParseEntry,
  prev: ParseEntry | undefined,
  next: ParseEntry | undefined,
  nextNext: ParseEntry | undefined,
  nextNextNext: ParseEntry | undefined,
  redirections: Array<{ target: string; operator: '>' | '>>' }>,
  kept: ParseEntry[],
): { skip: number; dangerous: boolean } {
  const isFileDescriptor = (p: ParseEntry | undefined): p is string =>
    typeof p === 'string' && /^\d+$/.test(p.trim())
  if (isOperator(part, '>') || isOperator(part, '>>')) {
    const operator = (part as { op: '>' | '>>' }).op
    if (isFileDescriptor(prev)) {
      if (next === '!' && isSimpleTarget(nextNext)) {
        return handleFileDescriptorRedirection(
          prev.trim(),
          operator,
          nextNext,
          redirections,
          kept,
          2,
        )
      }
      if (next === '!' && hasDangerousExpansion(nextNext)) {
        return { skip: 0, dangerous: true }
      }
      if (isOperator(next, '|') && isSimpleTarget(nextNext)) {
        return handleFileDescriptorRedirection(
          prev.trim(),
          operator,
          nextNext,
          redirections,
          kept,
          2,
        )
      }
      if (isOperator(next, '|') && hasDangerousExpansion(nextNext)) {
        return { skip: 0, dangerous: true }
      }
      if (
        typeof next === 'string' &&
        next.startsWith('!') &&
        next.length > 1 &&
        next[1] !== '!' &&
        next[1] !== '-' &&
        next[1] !== '?' &&
        !/^!\d/.test(next)
      ) {
        const afterBang = next.substring(1)
        if (hasDangerousExpansion(afterBang)) {
          return { skip: 0, dangerous: true }
        }
        return handleFileDescriptorRedirection(
          prev.trim(),
          operator,
          afterBang,
          redirections,
          kept,
          1,
        )
      }
      return handleFileDescriptorRedirection(
        prev.trim(),
        operator,
        next,
        redirections,
        kept,
        1,
      )
    }
    if (isOperator(next, '|') && isSimpleTarget(nextNext)) {
      redirections.push({ target: nextNext as string, operator })
      return { skip: 2, dangerous: false }
    }
    if (isOperator(next, '|') && hasDangerousExpansion(nextNext)) {
      return { skip: 0, dangerous: true }
    }
    if (next === '!' && isSimpleTarget(nextNext)) {
      redirections.push({ target: nextNext as string, operator })
      return { skip: 2, dangerous: false }
    }
    if (next === '!' && hasDangerousExpansion(nextNext)) {
      return { skip: 0, dangerous: true }
    }
    if (
      typeof next === 'string' &&
      next.startsWith('!') &&
      next.length > 1 &&
      next[1] !== '!' &&
      next[1] !== '-' &&
      next[1] !== '?' &&
      !/^!\d/.test(next)
    ) {
      const afterBang = next.substring(1)
      if (hasDangerousExpansion(afterBang)) {
        return { skip: 0, dangerous: true }
      }
      redirections.push({ target: afterBang, operator })
      return { skip: 1, dangerous: false }
    }
    if (isOperator(next, '&')) {
      if (nextNext === '!' && isSimpleTarget(nextNextNext)) {
        redirections.push({ target: nextNextNext as string, operator })
        return { skip: 3, dangerous: false }
      }
      if (nextNext === '!' && hasDangerousExpansion(nextNextNext)) {
        return { skip: 0, dangerous: true }
      }
      if (isOperator(nextNext, '|') && isSimpleTarget(nextNextNext)) {
        redirections.push({ target: nextNextNext as string, operator })
        return { skip: 3, dangerous: false }
      }
      if (isOperator(nextNext, '|') && hasDangerousExpansion(nextNextNext)) {
        return { skip: 0, dangerous: true }
      }
      if (isSimpleTarget(nextNext)) {
        redirections.push({ target: nextNext as string, operator })
        return { skip: 2, dangerous: false }
      }
      if (hasDangerousExpansion(nextNext)) {
        return { skip: 0, dangerous: true }
      }
    }
    if (isSimpleTarget(next)) {
      redirections.push({ target: next, operator })
      return { skip: 1, dangerous: false }
    }
    if (hasDangerousExpansion(next)) {
      return { skip: 0, dangerous: true }
    }
  }
  if (isOperator(part, '>&')) {
    if (isFileDescriptor(prev) && isFileDescriptor(next)) {
      return { skip: 0, dangerous: false }
    }
    if (isOperator(next, '|') && isSimpleTarget(nextNext)) {
      redirections.push({ target: nextNext as string, operator: '>' })
      return { skip: 2, dangerous: false }
    }
    if (isOperator(next, '|') && hasDangerousExpansion(nextNext)) {
      return { skip: 0, dangerous: true }
    }
    if (next === '!' && isSimpleTarget(nextNext)) {
      redirections.push({ target: nextNext as string, operator: '>' })
      return { skip: 2, dangerous: false }
    }
    if (next === '!' && hasDangerousExpansion(nextNext)) {
      return { skip: 0, dangerous: true }
    }
    if (isSimpleTarget(next) && !isFileDescriptor(next)) {
      redirections.push({ target: next, operator: '>' })
      return { skip: 1, dangerous: false }
    }
    if (!isFileDescriptor(next) && hasDangerousExpansion(next)) {
      return { skip: 0, dangerous: true }
    }
  }
  return { skip: 0, dangerous: false }
}
function handleFileDescriptorRedirection(
  fd: string,
  operator: '>' | '>>',
  target: ParseEntry | undefined,
  redirections: Array<{ target: string; operator: '>' | '>>' }>,
  kept: ParseEntry[],
  skipCount = 1,
): { skip: number; dangerous: boolean } {
  const isStdout = fd === '1'
  const isFileTarget =
    target &&
    isSimpleTarget(target) &&
    typeof target === 'string' &&
    !/^\d+$/.test(target)
  const isFdTarget = typeof target === 'string' && /^\d+$/.test(target.trim())
  if (kept.length > 0) kept.pop()
  if (!isFdTarget && hasDangerousExpansion(target)) {
    return { skip: 0, dangerous: true }
  }
  if (isFileTarget) {
    redirections.push({ target: target as string, operator })
    if (!isStdout) {
      kept.push(fd + operator, target as string)
    }
    return { skip: skipCount, dangerous: false }
  }
  if (!isStdout) {
    kept.push(fd + operator)
    if (target) {
      kept.push(target)
      return { skip: 1, dangerous: false }
    }
  }
  return { skip: 0, dangerous: false }
}
function detectCommandSubstitution(
  prev: ParseEntry | undefined,
  kept: ParseEntry[],
  index: number,
): boolean {
  if (!prev || typeof prev !== 'string') return false
  if (prev === '$') return true
  if (prev.endsWith('$')) {
    if (prev.includes('=') && prev.endsWith('=$')) {
      return true
    }
    let depth = 1
    for (let j = index + 1; j < kept.length && depth > 0; j++) {
      if (isOperator(kept[j], '(')) depth++
      if (isOperator(kept[j], ')') && --depth === 0) {
        const after = kept[j + 1]
        return !!(after && typeof after === 'string' && !after.startsWith(' '))
      }
    }
  }
  return false
}
function needsQuoting(str: string): boolean {
  if (/^\d+>>?$/.test(str)) return false
  if (/\s/.test(str)) return true
  if (str.length === 1 && '><|&;()'.includes(str)) return true
  return false
}
function addToken(result: string, token: string, noSpace = false): string {
  if (!result || noSpace) return result + token
  return result + ' ' + token
}
function reconstructCommand(kept: ParseEntry[], originalCmd: string): string {
  if (!kept.length) return originalCmd
  let result = ''
  let cmdSubDepth = 0
  let inProcessSub = false
  for (let i = 0; i < kept.length; i++) {
    const part = kept[i]
    const prev = kept[i - 1]
    const next = kept[i + 1]
    if (typeof part === 'string') {
      const hasCommandSeparator = /[|&;]/.test(part)
      const str = hasCommandSeparator
        ? `"${part}"`
        : needsQuoting(part)
          ? quote([part])
          : part
      const endsWithDollar = str.endsWith('$')
      const nextIsParen =
        next && typeof next === 'object' && 'op' in next && next.op === '('
      const noSpace =
        result.endsWith('(') ||
        prev === '$' ||
        (typeof prev === 'object' && prev && 'op' in prev && prev.op === ')')
      if (result.endsWith('<(')) {
        result += ' ' + str
      } else {
        result = addToken(result, str, noSpace)
      }
      if (endsWithDollar && nextIsParen) {
      }
      continue
    }
    if (typeof part !== 'object' || !part || !('op' in part)) continue
    const op = part.op as string
    if (op === 'glob' && 'pattern' in part) {
      result = addToken(result, part.pattern as string)
      continue
    }
    if (
      op === '>&' &&
      typeof prev === 'string' &&
      /^\d+$/.test(prev) &&
      typeof next === 'string' &&
      /^\d+$/.test(next)
    ) {
      const lastIndex = result.lastIndexOf(prev)
      result = result.slice(0, lastIndex) + prev + op + next
      i++
      continue
    }
    if (op === '<' && isOperator(next, '<')) {
      const delimiter = kept[i + 2]
      if (delimiter && typeof delimiter === 'string') {
        result = addToken(result, delimiter)
        i += 2
        continue
      }
    }
    if (op === '<<<') {
      result = addToken(result, op)
      continue
    }
    if (op === '(') {
      const isCmdSub = detectCommandSubstitution(prev, kept, i)
      if (isCmdSub || cmdSubDepth > 0) {
        cmdSubDepth++
        if (result.endsWith(' ')) {
          result = result.slice(0, -1)
        }
        result += '('
      } else if (result.endsWith('$')) {
        if (detectCommandSubstitution(prev, kept, i)) {
          cmdSubDepth++
          result += '('
        } else {
          result = addToken(result, '(')
        }
      } else {
        const noSpace = result.endsWith('<(') || result.endsWith('(')
        result = addToken(result, '(', noSpace)
      }
      continue
    }
    if (op === ')') {
      if (inProcessSub) {
        inProcessSub = false
        result += ')'
        continue
      }
      if (cmdSubDepth > 0) cmdSubDepth--
      result += ')'
      continue
    }
    if (op === '<(') {
      inProcessSub = true
      result = addToken(result, op)
      continue
    }
    if (['&&', '||', '|', ';', '>', '>>', '<'].includes(op)) {
      result = addToken(result, op)
    }
  }
  return result.trim() || originalCmd
}
