import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.ts'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.ts'
import {
  containsVulnerableUncPath,
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  type FlagArgType,
  GH_READ_ONLY_COMMANDS,
  GIT_READ_ONLY_COMMANDS,
  PYRIGHT_READ_ONLY_COMMANDS,
  RIPGREP_READ_ONLY_COMMANDS,
  validateFlags,
} from '../../utils/shell/readOnlyCommandValidation.ts'
import type { PermissionResult } from './_compat/permissionTypes.ts'
import { bashCommandIsSafe_DEPRECATED } from './bashSecurity.ts'
import { isNormalizedGitCommand } from './bashPermissions.ts'
import {
  COMMAND_OPERATION_TYPE,
  PATH_EXTRACTORS,
  type PathCommand,
} from './pathValidation.ts'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.ts'
const getOriginalCwd = (): string => process.cwd()
const getCwd = (): string => process.cwd()
const isCurrentDirectoryBareGitRepo = (): boolean => false
const isSandboxingEnabled = (): boolean => false
type CommandConfig = {
  safeFlags: Record<string, FlagArgType>
  regex?: RegExp
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean
  respectsDoubleDash?: boolean
}
const FD_SAFE_FLAGS: Record<string, FlagArgType> = {
  '-h': 'none',
  '--help': 'none',
  '-V': 'none',
  '--version': 'none',
  '-H': 'none',
  '--hidden': 'none',
  '-I': 'none',
  '--no-ignore': 'none',
  '--no-ignore-vcs': 'none',
  '--no-ignore-parent': 'none',
  '-s': 'none',
  '--case-sensitive': 'none',
  '-i': 'none',
  '--ignore-case': 'none',
  '-g': 'none',
  '--glob': 'none',
  '--regex': 'none',
  '-F': 'none',
  '--fixed-strings': 'none',
  '-a': 'none',
  '--absolute-path': 'none',
  '-L': 'none',
  '--follow': 'none',
  '-p': 'none',
  '--full-path': 'none',
  '-0': 'none',
  '--print0': 'none',
  '-d': 'number',
  '--max-depth': 'number',
  '--min-depth': 'number',
  '--exact-depth': 'number',
  '-t': 'string',
  '--type': 'string',
  '-e': 'string',
  '--extension': 'string',
  '-S': 'string',
  '--size': 'string',
  '--changed-within': 'string',
  '--changed-before': 'string',
  '-o': 'string',
  '--owner': 'string',
  '-E': 'string',
  '--exclude': 'string',
  '--ignore-file': 'string',
  '-c': 'string',
  '--color': 'string',
  '-j': 'number',
  '--threads': 'number',
  '--max-buffer-time': 'string',
  '--max-results': 'number',
  '-1': 'none',
  '-q': 'none',
  '--quiet': 'none',
  '--show-errors': 'none',
  '--strip-cwd-prefix': 'none',
  '--one-file-system': 'none',
  '--prune': 'none',
  '--search-path': 'string',
  '--base-directory': 'string',
  '--path-separator': 'string',
  '--batch-size': 'number',
  '--no-require-git': 'none',
  '--hyperlink': 'string',
  '--and': 'string',
  '--format': 'string',
}
const COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
  xargs: {
    safeFlags: {
      '-I': '{}',
      '-n': 'number',
      '-P': 'number',
      '-L': 'number',
      '-s': 'number',
      '-E': 'EOF',
      '-0': 'none',
      '-t': 'none',
      '-r': 'none',
      '-x': 'none',
      '-d': 'char',
    },
  },
  ...GIT_READ_ONLY_COMMANDS,
  file: {
    safeFlags: {
      '--brief': 'none',
      '-b': 'none',
      '--mime': 'none',
      '-i': 'none',
      '--mime-type': 'none',
      '--mime-encoding': 'none',
      '--apple': 'none',
      '--check-encoding': 'none',
      '-c': 'none',
      '--exclude': 'string',
      '--exclude-quiet': 'string',
      '--print0': 'none',
      '-0': 'none',
      '-f': 'string',
      '-F': 'string',
      '--separator': 'string',
      '--help': 'none',
      '--version': 'none',
      '-v': 'none',
      '--no-dereference': 'none',
      '-h': 'none',
      '--dereference': 'none',
      '-L': 'none',
      '--magic-file': 'string',
      '-m': 'string',
      '--keep-going': 'none',
      '-k': 'none',
      '--list': 'none',
      '-l': 'none',
      '--no-buffer': 'none',
      '-n': 'none',
      '--preserve-date': 'none',
      '-p': 'none',
      '--raw': 'none',
      '-r': 'none',
      '-s': 'none',
      '--special-files': 'none',
      '--uncompress': 'none',
      '-z': 'none',
    },
  },
  sed: {
    safeFlags: {
      '--expression': 'string',
      '-e': 'string',
      '--quiet': 'none',
      '--silent': 'none',
      '-n': 'none',
      '--regexp-extended': 'none',
      '-r': 'none',
      '--posix': 'none',
      '-E': 'none',
      '--line-length': 'number',
      '-l': 'number',
      '--zero-terminated': 'none',
      '-z': 'none',
      '--separate': 'none',
      '-s': 'none',
      '--unbuffered': 'none',
      '-u': 'none',
      '--debug': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    additionalCommandIsDangerousCallback: (
      rawCommand: string,
      _args: string[],
    ) => !sedCommandIsAllowedByAllowlist(rawCommand),
  },
  sort: {
    safeFlags: {
      '--ignore-leading-blanks': 'none',
      '-b': 'none',
      '--dictionary-order': 'none',
      '-d': 'none',
      '--ignore-case': 'none',
      '-f': 'none',
      '--general-numeric-sort': 'none',
      '-g': 'none',
      '--human-numeric-sort': 'none',
      '-h': 'none',
      '--ignore-nonprinting': 'none',
      '-i': 'none',
      '--month-sort': 'none',
      '-M': 'none',
      '--numeric-sort': 'none',
      '-n': 'none',
      '--random-sort': 'none',
      '-R': 'none',
      '--reverse': 'none',
      '-r': 'none',
      '--sort': 'string',
      '--stable': 'none',
      '-s': 'none',
      '--unique': 'none',
      '-u': 'none',
      '--version-sort': 'none',
      '-V': 'none',
      '--zero-terminated': 'none',
      '-z': 'none',
      '--key': 'string',
      '-k': 'string',
      '--field-separator': 'string',
      '-t': 'string',
      '--check': 'none',
      '-c': 'none',
      '--check-char-order': 'none',
      '-C': 'none',
      '--merge': 'none',
      '-m': 'none',
      '--buffer-size': 'string',
      '-S': 'string',
      '--parallel': 'number',
      '--batch-size': 'number',
      '--help': 'none',
      '--version': 'none',
    },
  },
  man: {
    safeFlags: {
      '-a': 'none',
      '--all': 'none',
      '-d': 'none',
      '-f': 'none',
      '--whatis': 'none',
      '-h': 'none',
      '-k': 'none',
      '--apropos': 'none',
      '-l': 'string',
      '-w': 'none',
      '-S': 'string',
      '-s': 'string',
    },
  },
  help: {
    safeFlags: {
      '-d': 'none',
      '-m': 'none',
      '-s': 'none',
    },
  },
  netstat: {
    safeFlags: {
      '-a': 'none',
      '-L': 'none',
      '-l': 'none',
      '-n': 'none',
      '-f': 'string',
      '-g': 'none',
      '-i': 'none',
      '-I': 'string',
      '-s': 'none',
      '-r': 'none',
      '-m': 'none',
      '-v': 'none',
    },
  },
  ps: {
    safeFlags: {
      '-e': 'none',
      '-A': 'none',
      '-a': 'none',
      '-d': 'none',
      '-N': 'none',
      '--deselect': 'none',
      '-f': 'none',
      '-F': 'none',
      '-l': 'none',
      '-j': 'none',
      '-y': 'none',
      '-w': 'none',
      '-ww': 'none',
      '--width': 'number',
      '-c': 'none',
      '-H': 'none',
      '--forest': 'none',
      '--headers': 'none',
      '--no-headers': 'none',
      '-n': 'string',
      '--sort': 'string',
      '-L': 'none',
      '-T': 'none',
      '-m': 'none',
      '-C': 'string',
      '-G': 'string',
      '-g': 'string',
      '-p': 'string',
      '--pid': 'string',
      '-q': 'string',
      '--quick-pid': 'string',
      '-s': 'string',
      '--sid': 'string',
      '-t': 'string',
      '--tty': 'string',
      '-U': 'string',
      '-u': 'string',
      '--user': 'string',
      '--help': 'none',
      '--info': 'none',
      '-V': 'none',
      '--version': 'none',
    },
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      return args.some(
        a => !a.startsWith('-') && /^[a-zA-Z]*e[a-zA-Z]*$/.test(a),
      )
    },
  },
  base64: {
    respectsDoubleDash: false,
    safeFlags: {
      '-d': 'none',
      '-D': 'none',
      '--decode': 'none',
      '-b': 'number',
      '--break': 'number',
      '-w': 'number',
      '--wrap': 'number',
      '-i': 'string',
      '--input': 'string',
      '--ignore-garbage': 'none',
      '-h': 'none',
      '--help': 'none',
      '--version': 'none',
    },
  },
  grep: {
    safeFlags: {
      '-e': 'string',
      '--regexp': 'string',
      '-f': 'string',
      '--file': 'string',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-G': 'none',
      '--basic-regexp': 'none',
      '-E': 'none',
      '--extended-regexp': 'none',
      '-P': 'none',
      '--perl-regexp': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
      '--no-ignore-case': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-x': 'none',
      '--line-regexp': 'none',
      '-c': 'none',
      '--count': 'none',
      '--color': 'string',
      '--colour': 'string',
      '-L': 'none',
      '--files-without-match': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '-m': 'number',
      '--max-count': 'number',
      '-o': 'none',
      '--only-matching': 'none',
      '-q': 'none',
      '--quiet': 'none',
      '--silent': 'none',
      '-s': 'none',
      '--no-messages': 'none',
      '-b': 'none',
      '--byte-offset': 'none',
      '-H': 'none',
      '--with-filename': 'none',
      '-h': 'none',
      '--no-filename': 'none',
      '--label': 'string',
      '-n': 'none',
      '--line-number': 'none',
      '-T': 'none',
      '--initial-tab': 'none',
      '-u': 'none',
      '--unix-byte-offsets': 'none',
      '-Z': 'none',
      '--null': 'none',
      '-z': 'none',
      '--null-data': 'none',
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '--group-separator': 'string',
      '--no-group-separator': 'none',
      '-a': 'none',
      '--text': 'none',
      '--binary-files': 'string',
      '-D': 'string',
      '--devices': 'string',
      '-d': 'string',
      '--directories': 'string',
      '--exclude': 'string',
      '--exclude-from': 'string',
      '--exclude-dir': 'string',
      '--include': 'string',
      '-r': 'none',
      '--recursive': 'none',
      '-R': 'none',
      '--dereference-recursive': 'none',
      '--line-buffered': 'none',
      '-U': 'none',
      '--binary': 'none',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },
  ...RIPGREP_READ_ONLY_COMMANDS,
  sha256sum: {
    safeFlags: {
      '-b': 'none',
      '--binary': 'none',
      '-t': 'none',
      '--text': 'none',
      '-c': 'none',
      '--check': 'none',
      '--ignore-missing': 'none',
      '--quiet': 'none',
      '--status': 'none',
      '--strict': 'none',
      '-w': 'none',
      '--warn': 'none',
      '--tag': 'none',
      '-z': 'none',
      '--zero': 'none',
      '--help': 'none',
      '--version': 'none',
    },
  },
  sha1sum: {
    safeFlags: {
      '-b': 'none',
      '--binary': 'none',
      '-t': 'none',
      '--text': 'none',
      '-c': 'none',
      '--check': 'none',
      '--ignore-missing': 'none',
      '--quiet': 'none',
      '--status': 'none',
      '--strict': 'none',
      '-w': 'none',
      '--warn': 'none',
      '--tag': 'none',
      '-z': 'none',
      '--zero': 'none',
      '--help': 'none',
      '--version': 'none',
    },
  },
  md5sum: {
    safeFlags: {
      '-b': 'none',
      '--binary': 'none',
      '-t': 'none',
      '--text': 'none',
      '-c': 'none',
      '--check': 'none',
      '--ignore-missing': 'none',
      '--quiet': 'none',
      '--status': 'none',
      '--strict': 'none',
      '-w': 'none',
      '--warn': 'none',
      '--tag': 'none',
      '-z': 'none',
      '--zero': 'none',
      '--help': 'none',
      '--version': 'none',
    },
  },
  tree: {
    safeFlags: {
      '-a': 'none',
      '-d': 'none',
      '-l': 'none',
      '-f': 'none',
      '-x': 'none',
      '-L': 'number',
      '-P': 'string',
      '-I': 'string',
      '--gitignore': 'none',
      '--gitfile': 'string',
      '--ignore-case': 'none',
      '--matchdirs': 'none',
      '--metafirst': 'none',
      '--prune': 'none',
      '--info': 'none',
      '--infofile': 'string',
      '--noreport': 'none',
      '--charset': 'string',
      '--filelimit': 'number',
      '-q': 'none',
      '-N': 'none',
      '-Q': 'none',
      '-p': 'none',
      '-u': 'none',
      '-g': 'none',
      '-s': 'none',
      '-h': 'none',
      '--si': 'none',
      '--du': 'none',
      '-D': 'none',
      '--timefmt': 'string',
      '-F': 'none',
      '--inodes': 'none',
      '--device': 'none',
      '-v': 'none',
      '-t': 'none',
      '-c': 'none',
      '-U': 'none',
      '-r': 'none',
      '--dirsfirst': 'none',
      '--filesfirst': 'none',
      '--sort': 'string',
      '-i': 'none',
      '-A': 'none',
      '-S': 'none',
      '-n': 'none',
      '-C': 'none',
      '-X': 'none',
      '-J': 'none',
      '-H': 'string',
      '--nolinks': 'none',
      '--hintro': 'string',
      '--houtro': 'string',
      '-T': 'string',
      '--hyperlink': 'none',
      '--scheme': 'string',
      '--authority': 'string',
      '--fromfile': 'none',
      '--fromtabfile': 'none',
      '--fflinks': 'none',
      '--help': 'none',
      '--version': 'none',
    },
  },
  date: {
    safeFlags: {
      '-d': 'string',
      '--date': 'string',
      '-r': 'string',
      '--reference': 'string',
      '-u': 'none',
      '--utc': 'none',
      '--universal': 'none',
      '-I': 'none',
      '--iso-8601': 'string',
      '-R': 'none',
      '--rfc-email': 'none',
      '--rfc-3339': 'string',
      '--debug': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      const flagsWithArgs = new Set([
        '-d',
        '--date',
        '-r',
        '--reference',
        '--iso-8601',
        '--rfc-3339',
      ])
      let i = 0
      while (i < args.length) {
        const token = args[i]!
        if (token.startsWith('--') && token.includes('=')) {
          i++
        } else if (token.startsWith('-')) {
          if (flagsWithArgs.has(token)) {
            i += 2
          } else {
            i++
          }
        } else {
          if (!token.startsWith('+')) {
            return true
          }
          i++
        }
      }
      return false
    },
  },
  hostname: {
    safeFlags: {
      '-f': 'none',
      '--fqdn': 'none',
      '--long': 'none',
      '-s': 'none',
      '--short': 'none',
      '-i': 'none',
      '--ip-address': 'none',
      '-I': 'none',
      '--all-ip-addresses': 'none',
      '-a': 'none',
      '--alias': 'none',
      '-d': 'none',
      '--domain': 'none',
      '-A': 'none',
      '--all-fqdns': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '-h': 'none',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
    regex: /^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$/,
  },
  info: {
    safeFlags: {
      '-f': 'string',
      '--file': 'string',
      '-d': 'string',
      '--directory': 'string',
      '-n': 'string',
      '--node': 'string',
      '-a': 'none',
      '--all': 'none',
      '-k': 'string',
      '--apropos': 'string',
      '-w': 'none',
      '--where': 'none',
      '--location': 'none',
      '--show-options': 'none',
      '--vi-keys': 'none',
      '--subnodes': 'none',
      '-h': 'none',
      '--help': 'none',
      '--usage': 'none',
      '--version': 'none',
    },
  },
  lsof: {
    safeFlags: {
      '-?': 'none',
      '-h': 'none',
      '-v': 'none',
      '-a': 'none',
      '-b': 'none',
      '-C': 'none',
      '-l': 'none',
      '-n': 'none',
      '-N': 'none',
      '-O': 'none',
      '-P': 'none',
      '-Q': 'none',
      '-R': 'none',
      '-t': 'none',
      '-U': 'none',
      '-V': 'none',
      '-X': 'none',
      '-H': 'none',
      '-E': 'none',
      '-F': 'none',
      '-g': 'none',
      '-i': 'none',
      '-K': 'none',
      '-L': 'none',
      '-o': 'none',
      '-r': 'none',
      '-s': 'none',
      '-S': 'none',
      '-T': 'none',
      '-x': 'none',
      '-A': 'string',
      '-c': 'string',
      '-d': 'string',
      '-e': 'string',
      '-k': 'string',
      '-p': 'string',
      '-u': 'string',
    },
    additionalCommandIsDangerousCallback: (_rawCommand, args) =>
      args.some(a => a === '+m' || a.startsWith('+m')),
  },
  pgrep: {
    safeFlags: {
      '-d': 'string',
      '--delimiter': 'string',
      '-l': 'none',
      '--list-name': 'none',
      '-a': 'none',
      '--list-full': 'none',
      '-v': 'none',
      '--inverse': 'none',
      '-w': 'none',
      '--lightweight': 'none',
      '-c': 'none',
      '--count': 'none',
      '-f': 'none',
      '--full': 'none',
      '-g': 'string',
      '--pgroup': 'string',
      '-G': 'string',
      '--group': 'string',
      '-i': 'none',
      '--ignore-case': 'none',
      '-n': 'none',
      '--newest': 'none',
      '-o': 'none',
      '--oldest': 'none',
      '-O': 'string',
      '--older': 'string',
      '-P': 'string',
      '--parent': 'string',
      '-s': 'string',
      '--session': 'string',
      '-t': 'string',
      '--terminal': 'string',
      '-u': 'string',
      '--euid': 'string',
      '-U': 'string',
      '--uid': 'string',
      '-x': 'none',
      '--exact': 'none',
      '-F': 'string',
      '--pidfile': 'string',
      '-L': 'none',
      '--logpidfile': 'none',
      '-r': 'string',
      '--runstates': 'string',
      '--ns': 'string',
      '--nslist': 'string',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },
  tput: {
    safeFlags: {
      '-T': 'string',
      '-V': 'none',
      '-x': 'none',
    },
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      const DANGEROUS_CAPABILITIES = new Set([
        'init',
        'reset',
        'rs1',
        'rs2',
        'rs3',
        'is1',
        'is2',
        'is3',
        'iprog',
        'if',
        'rf',
        'clear',
        'flash',
        'mc0',
        'mc4',
        'mc5',
        'mc5i',
        'mc5p',
        'pfkey',
        'pfloc',
        'pfx',
        'pfxl',
        'smcup',
        'rmcup',
      ])
      const flagsWithArgs = new Set(['-T'])
      let i = 0
      let afterDoubleDash = false
      while (i < args.length) {
        const token = args[i]!
        if (token === '--') {
          afterDoubleDash = true
          i++
        } else if (!afterDoubleDash && token.startsWith('-')) {
          if (token === '-S') return true
          if (
            !token.startsWith('--') &&
            token.length > 2 &&
            token.includes('S')
          )
            return true
          if (flagsWithArgs.has(token)) {
            i += 2
          } else {
            i++
          }
        } else {
          if (DANGEROUS_CAPABILITIES.has(token)) return true
          i++
        }
      }
      return false
    },
  },
  ss: {
    safeFlags: {
      '-h': 'none',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
      '-n': 'none',
      '--numeric': 'none',
      '-r': 'none',
      '--resolve': 'none',
      '-a': 'none',
      '--all': 'none',
      '-l': 'none',
      '--listening': 'none',
      '-o': 'none',
      '--options': 'none',
      '-e': 'none',
      '--extended': 'none',
      '-m': 'none',
      '--memory': 'none',
      '-p': 'none',
      '--processes': 'none',
      '-i': 'none',
      '--info': 'none',
      '-s': 'none',
      '--summary': 'none',
      '-4': 'none',
      '--ipv4': 'none',
      '-6': 'none',
      '--ipv6': 'none',
      '-0': 'none',
      '--packet': 'none',
      '-t': 'none',
      '--tcp': 'none',
      '-M': 'none',
      '--mptcp': 'none',
      '-S': 'none',
      '--sctp': 'none',
      '-u': 'none',
      '--udp': 'none',
      '-d': 'none',
      '--dccp': 'none',
      '-w': 'none',
      '--raw': 'none',
      '-x': 'none',
      '--unix': 'none',
      '--tipc': 'none',
      '--vsock': 'none',
      '-f': 'string',
      '--family': 'string',
      '-A': 'string',
      '--query': 'string',
      '--socket': 'string',
      '-Z': 'none',
      '--context': 'none',
      '-z': 'none',
      '--contexts': 'none',
      '-b': 'none',
      '--bpf': 'none',
      '-E': 'none',
      '--events': 'none',
      '-H': 'none',
      '--no-header': 'none',
      '-O': 'none',
      '--oneline': 'none',
      '--tipcinfo': 'none',
      '--tos': 'none',
      '--cgroup': 'none',
      '--inet-sockopt': 'none',
    },
  },
  fd: { safeFlags: { ...FD_SAFE_FLAGS } },
  fdfind: { safeFlags: { ...FD_SAFE_FLAGS } },
  ...PYRIGHT_READ_ONLY_COMMANDS,
  ...DOCKER_READ_ONLY_COMMANDS,
}
const ANT_ONLY_COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
  ...GH_READ_ONLY_COMMANDS,
  aki: {
    safeFlags: {
      '-h': 'none',
      '--help': 'none',
      '-k': 'none',
      '--keyword': 'none',
      '-s': 'none',
      '--semantic': 'none',
      '--no-adaptive': 'none',
      '-n': 'number',
      '--limit': 'number',
      '-o': 'number',
      '--offset': 'number',
      '--source': 'string',
      '--exclude-source': 'string',
      '-a': 'string',
      '--after': 'string',
      '-b': 'string',
      '--before': 'string',
      '--collection': 'string',
      '--drive': 'string',
      '--folder': 'string',
      '--descendants': 'none',
      '-m': 'string',
      '--meta': 'string',
      '-t': 'string',
      '--threshold': 'string',
      '--kw-weight': 'string',
      '--sem-weight': 'string',
      '-j': 'none',
      '--json': 'none',
      '-c': 'none',
      '--chunk': 'none',
      '--preview': 'none',
      '-d': 'none',
      '--full-doc': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--stats': 'none',
      '-S': 'number',
      '--summarize': 'number',
      '--explain': 'none',
      '--examine': 'string',
      '--url': 'string',
      '--multi-turn': 'number',
      '--multi-turn-model': 'string',
      '--multi-turn-context': 'string',
      '--no-rerank': 'none',
      '--audit': 'none',
      '--local': 'none',
      '--staging': 'none',
    },
  },
}
function getCommandAllowlist(): Record<string, CommandConfig> {
  let allowlist: Record<string, CommandConfig> = COMMAND_ALLOWLIST
  if (process.env.USER_TYPE === 'ant') {
    return { ...allowlist, ...ANT_ONLY_COMMAND_ALLOWLIST }
  }
  return allowlist
}
const SAFE_TARGET_COMMANDS_FOR_XARGS = [
  'echo',
  'printf',
  'wc',
  'grep',
  'head',
  'tail',
]
export function isCommandSafeViaFlagParsing(command: string): boolean {
  const parseResult = tryParseShellCommand(command, env => `$${env}`)
  if (!parseResult.success) return false
  const parsed = parseResult.tokens.map(token => {
    if (typeof token !== 'string') {
      token = token as { op: 'glob'; pattern: string }
      if (token.op === 'glob') {
        return token.pattern
      }
    }
    return token
  })
  const hasOperators = parsed.some(token => typeof token !== 'string')
  if (hasOperators) {
    return false
  }
  const tokens = parsed as string[]
  if (tokens.length === 0) {
    return false
  }
  let commandConfig: CommandConfig | undefined
  let commandTokens: number = 0
  const allowlist = getCommandAllowlist()
  for (const [cmdPattern] of Object.entries(allowlist)) {
    const cmdTokens = cmdPattern.split(' ')
    if (tokens.length >= cmdTokens.length) {
      let matches = true
      for (let i = 0; i < cmdTokens.length; i++) {
        if (tokens[i] !== cmdTokens[i]) {
          matches = false
          break
        }
      }
      if (matches) {
        commandConfig = allowlist[cmdPattern]
        commandTokens = cmdTokens.length
        break
      }
    }
  }
  if (!commandConfig) {
    return false
  }
  if (tokens[0] === 'git' && tokens[1] === 'ls-remote') {
    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i]
      if (token && !token.startsWith('-')) {
        if (token.includes('://')) {
          return false
        }
        if (token.includes('@') || token.includes(':')) {
          return false
        }
        if (token.includes('$')) {
          return false
        }
      }
    }
  }
  for (let i = commandTokens; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    if (token.includes('$')) {
      return false
    }
    if (token.includes('{') && (token.includes(',') || token.includes('..'))) {
      return false
    }
  }
  if (
    !validateFlags(tokens, commandTokens, commandConfig, {
      commandName: tokens[0],
      rawCommand: command,
      xargsTargetCommands:
        tokens[0] === 'xargs' ? SAFE_TARGET_COMMANDS_FOR_XARGS : undefined,
    })
  ) {
    return false
  }
  if (commandConfig.regex && !commandConfig.regex.test(command)) {
    return false
  }
  if (!commandConfig.regex && /`/.test(command)) {
    return false
  }
  if (
    !commandConfig.regex &&
    (tokens[0] === 'rg' || tokens[0] === 'grep') &&
    /[\n\r]/.test(command)
  ) {
    return false
  }
  if (
    commandConfig.additionalCommandIsDangerousCallback &&
    commandConfig.additionalCommandIsDangerousCallback(
      command,
      tokens.slice(commandTokens),
    )
  ) {
    return false
  }
  return true
}
function makeRegexForSafeCommand(command: string): RegExp {
  return new RegExp(`^${command}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`)
}
const READONLY_COMMANDS = [
  ...EXTERNAL_READONLY_COMMANDS,
  'cal',
  'uptime',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'strings',
  'hexdump',
  'od',
  'nl',
  'id',
  'uname',
  'free',
  'df',
  'du',
  'locale',
  'groups',
  'nproc',
  'basename',
  'dirname',
  'realpath',
  'cut',
  'paste',
  'tr',
  'column',
  'tac',
  'rev',
  'fold',
  'expand',
  'unexpand',
  'fmt',
  'comm',
  'cmp',
  'numfmt',
  'readlink',
  'diff',
  'true',
  'false',
  'sleep',
  'which',
  'type',
  'expr',
  'test',
  'getconf',
  'seq',
  'tsort',
  'pr',
]
const READONLY_COMMAND_REGEXES = new Set([
  ...READONLY_COMMANDS.map(makeRegexForSafeCommand),
  /^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,
  /^claude -h$/,
  /^claude --help$/,
  /^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/,
  /^pwd$/,
  /^whoami$/,
  /^node -v$/,
  /^node --version$/,
  /^python --version$/,
  /^python3 --version$/,
  /^history(?:\s+\d+)?\s*$/,
  /^alias$/,
  /^arch(?:\s+(?:--help|-h))?\s*$/,
  /^ip addr$/,
  /^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/,
  /^jq(?!\s+.*(?:-f\b|--from-file|--rawfile|--slurpfile|--run-tests|-L\b|--library-path|\benv\b|\$ENV\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,
  /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
  /^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
  /^find(?:\s+(?:\\[()]|(?!-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b)[^<>()$`|{}&;\n\r\s]|\s)+)?$/,
])
export function containsUnquotedExpansion(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < command.length; i++) {
    const currentChar = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (inSingleQuote) {
      continue
    }
    if (currentChar === '$') {
      const next = command[i + 1]
      if (next && /[A-Za-z_@*#?!$0-9-]/.test(next)) {
        return true
      }
    }
    if (inDoubleQuote) {
      continue
    }
    if (currentChar && /[?*[\]]/.test(currentChar)) {
      return true
    }
  }
  return false
}
function isCommandReadOnly(command: string): boolean {
  let testCommand = command.trim()
  if (testCommand.endsWith(' 2>&1')) {
    testCommand = testCommand.slice(0, -5).trim()
  }
  if (containsVulnerableUncPath(testCommand)) {
    return false
  }
  if (containsUnquotedExpansion(testCommand)) {
    return false
  }
  if (isCommandSafeViaFlagParsing(testCommand)) {
    return true
  }
  for (const regex of READONLY_COMMAND_REGEXES) {
    if (regex.test(testCommand)) {
      if (testCommand.includes('git') && /\s-c[\s=]/.test(testCommand)) {
        return false
      }
      if (
        testCommand.includes('git') &&
        /\s--exec-path[\s=]/.test(testCommand)
      ) {
        return false
      }
      if (
        testCommand.includes('git') &&
        /\s--config-env[\s=]/.test(testCommand)
      ) {
        return false
      }
      return true
    }
  }
  return false
}
function commandHasAnyGit(command: string): boolean {
  return splitCommand_DEPRECATED(command).some(subcmd =>
    isNormalizedGitCommand(subcmd.trim()),
  )
}
const GIT_INTERNAL_PATTERNS = [
  /^HEAD$/,
  /^objects(?:\/|$)/,
  /^refs(?:\/|$)/,
  /^hooks(?:\/|$)/,
]
function isGitInternalPath(path: string): boolean {
  const normalized = path.replace(/^\.?\//, '')
  return GIT_INTERNAL_PATTERNS.some(pattern => pattern.test(normalized))
}
const NON_CREATING_WRITE_COMMANDS = new Set(['rm', 'rmdir', 'sed'])
function extractWritePathsFromSubcommand(subcommand: string): string[] {
  const parseResult = tryParseShellCommand(subcommand, env => `$${env}`)
  if (!parseResult.success) return []
  const tokens = parseResult.tokens.filter(
    (t): t is string => typeof t === 'string',
  )
  if (tokens.length === 0) return []
  const baseCmd = tokens[0]
  if (!baseCmd) return []
  if (!(baseCmd in COMMAND_OPERATION_TYPE)) {
    return []
  }
  const opType = COMMAND_OPERATION_TYPE[baseCmd as PathCommand]
  if (
    (opType !== 'write' && opType !== 'create') ||
    NON_CREATING_WRITE_COMMANDS.has(baseCmd)
  ) {
    return []
  }
  const extractor = PATH_EXTRACTORS[baseCmd as PathCommand]
  if (!extractor) return []
  return extractor(tokens.slice(1))
}
function commandWritesToGitInternalPaths(command: string): boolean {
  const subcommands = splitCommand_DEPRECATED(command)
  for (const subcmd of subcommands) {
    const trimmed = subcmd.trim()
    const writePaths = extractWritePathsFromSubcommand(trimmed)
    for (const path of writePaths) {
      if (isGitInternalPath(path)) {
        return true
      }
    }
    const { redirections } = extractOutputRedirections(trimmed)
    for (const { target } of redirections) {
      if (isGitInternalPath(target)) {
        return true
      }
    }
  }
  return false
}
export function checkReadOnlyConstraints(
  input: { command: string; [key: string]: unknown },
  compoundCommandHasCd: boolean,
): PermissionResult {
  const { command } = input
  const result = tryParseShellCommand(command, env => `$${env}`)
  if (!result.success) {
    return {
      behavior: 'passthrough',
      message: 'Command cannot be parsed, requires further permission checks',
    }
  }
  if (bashCommandIsSafe_DEPRECATED(command).behavior !== 'passthrough') {
    return {
      behavior: 'passthrough',
      message: 'Command is not read-only, requires further permission checks',
    }
  }
  if (containsVulnerableUncPath(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains Windows UNC path that could be vulnerable to WebDAV attacks',
    }
  }
  const hasGitCommand = commandHasAnyGit(command)
  if (compoundCommandHasCd && hasGitCommand) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands with cd and git require permission checks for enhanced security',
    }
  }
  if (hasGitCommand && isCurrentDirectoryBareGitRepo()) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands in directories with bare repository structure require permission checks for enhanced security',
    }
  }
  if (hasGitCommand && commandWritesToGitInternalPaths(command)) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands that create git internal files and run git require permission checks for enhanced security',
    }
  }
  if (
    hasGitCommand &&
    isSandboxingEnabled() &&
    getCwd() !== getOriginalCwd()
  ) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands outside the original working directory require permission checks when sandbox is enabled',
    }
  }
  const allSubcommandsReadOnly = splitCommand_DEPRECATED(command).every(
    subcmd => {
      if (bashCommandIsSafe_DEPRECATED(subcmd).behavior !== 'passthrough') {
        return false
      }
      return isCommandReadOnly(subcmd)
    },
  )
  if (allSubcommandsReadOnly) {
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  }
  return {
    behavior: 'passthrough',
    message: 'Command is not read-only, requires further permission checks',
  }
}
