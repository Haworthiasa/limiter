// Which filter a log goes to, by its content alone. Order: pytest, cuda, train, docker,
// generic; this release has filters for pytest and generic only, the rest fall through.

export type Kind = 'pytest' | 'cuda' | 'docker' | 'train' | 'generic'

const PYTEST_SUMMARY = /^=+ .*\b(passed|failed|errors?)\b.* =+$/m
const PYTEST_SHORT = /^=+ short test summary info =+$/m
const PYTEST_START = /^=+ test session starts =+$/m

export function detect(text: string): Kind {
  if (PYTEST_SHORT.test(text) || PYTEST_SUMMARY.test(text) || PYTEST_START.test(text)) return 'pytest'
  return 'generic'
}
