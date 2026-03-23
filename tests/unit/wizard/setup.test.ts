import { describe, expect, it } from 'vitest'
import { parsePrioritySelectionInput } from '../../../src/wizard/setup.js'

describe('parsePrioritySelectionInput', () => {
  it('parses space and comma separated priority input', () => {
    expect(parsePrioritySelectionInput('2 1 3', 3)).toEqual([2, 1, 3])
    expect(parsePrioritySelectionInput('3,1', 3)).toEqual([3, 1])
  })

  it('rejects invalid priority input', () => {
    expect(parsePrioritySelectionInput('', 3)).toBeUndefined()
    expect(parsePrioritySelectionInput('1 1', 3)).toBeUndefined()
    expect(parsePrioritySelectionInput('4', 3)).toBeUndefined()
    expect(parsePrioritySelectionInput('one two', 3)).toBeUndefined()
  })
})
