import * as vscode from 'vscode'

import { detectMultiline } from './detect-multiline'
import { getNextNonEmptyLine, getPrevNonEmptyLine, lines } from './text-processing'

export interface DocumentContext {
    prefix: string
    suffix: string

    /** The range that overlaps the included prefix and suffix */
    contextRange: vscode.Range

    /** Text before the cursor on the same line. */
    currentLinePrefix: string
    /** Text after the cursor on the same line. */
    currentLineSuffix: string

    prevNonEmptyLine: string
    nextNonEmptyLine: string

    /**
     * This is set when the document context is looking at the selected item in the
     * suggestion widget and injects the item into the prefix.
     */
    injectedPrefix: string | null

    multilineTrigger: string | null
}

interface GetCurrentDocContextParams {
    document: vscode.TextDocument
    position: vscode.Position
    maxPrefixLength: number
    maxSuffixLength: number
    enableExtendedTriggers: boolean
    syntacticTriggers?: boolean
    context?: vscode.InlineCompletionContext
}

interface SemanticContext {
    semanticContext: string[]
    similarityScore: number
}

function getSemanticContextWithinDocument(
    document: vscode.TextDocument,
    position: vscode.Position,
    k: number
): SemanticContext {
    const currentLine = document.lineAt(position.line).text

    let mostSimilarContext: SemanticContext = {
        semanticContext: [],
        similarityScore: 0,
    }
    let highestScore = 0

    // Ensure we don't go out of bounds when looking at blocks of k lines
    for (let i = 0; i <= document.lineCount - k; i++) {
        const blockOfLines = Array.from({ length: k }, (_, idx) => document.lineAt(i + idx).text)

        // Calculate semantic similarity between current line and this block of lines
        const aggregateSimilarityScore = blockOfLines.reduce(
            (acc, line) => acc + semanticSimilarity(currentLine, line),
            0
        )

        // Check if this block of lines is the most similar so far
        if (aggregateSimilarityScore > highestScore) {
            mostSimilarContext = {
                semanticContext: blockOfLines,
                similarityScore: aggregateSimilarityScore,
            }
            highestScore = aggregateSimilarityScore
        }
    }

    return mostSimilarContext
}

function semanticSimilarity(text1: string, text2: string): number {
    // Placeholder implementation using Levenshtein distance; need to replace this by embedding based similarity
    const distance = levenshteinDistance(text1, text2)
    return 1 - distance / Math.max(text1.length, text2.length)
}

function levenshteinDistance(text1: string, text2: string): number {
    if (text1.length === 0) {
        return text2.length
    }
    if (text2.length === 0) {
        return text1.length
    }

    const matrix = []

    // initialize matrix of all 0's
    for (let i = 0; i <= text2.length; i++) {
        matrix[i] = [...new Array(text1.length + 1)].map(x => 0)
    }

    // populate matrix
    for (let i = 0; i <= text2.length; i++) {
        for (let j = 0; j <= text1.length; j++) {
            if (i === 0) {
                matrix[i][j] = j
            } else if (j === 0) {
                matrix[i][j] = i
            } else {
                const indicator = text1[j - 1] === text2[i - 1] ? 0 : 1
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1, // deletion
                    matrix[i][j - 1] + 1, // insertion
                    matrix[i - 1][j - 1] + indicator // substitution
                )
            }
        }
    }

    return matrix[text2.length][text1.length]
}

/**
 * Get the current document context based on the cursor position in the current document.
 *
 * This function is meant to provide a context around the current position in the document,
 * including a prefix, a suffix, the previous line, the previous non-empty line, and the next non-empty line.
 * The prefix and suffix are obtained by looking around the current position up to a max length
 * defined by `maxPrefixLength` and `maxSuffixLength` respectively. If the length of the entire
 * document content in either direction is smaller than these parameters, the entire content will be used.
 *
 * @param document - A `vscode.TextDocument` object, the document in which to find the context.
 * @param position - A `vscode.Position` object, the position in the document from which to find the context.
 * @param maxPrefixLength - A number representing the maximum length of the prefix to get from the document.
 * @param maxSuffixLength - A number representing the maximum length of the suffix to get from the document.
 *
 * @returns An object containing the current document context or null if there are no lines in the document.
 */
export function getCurrentDocContext(params: GetCurrentDocContextParams): DocumentContext {
    const { document, position, maxPrefixLength, maxSuffixLength, enableExtendedTriggers, context, syntacticTriggers } =
        params
    const offset = document.offsetAt(position)

    // TODO(philipp-spiess): This requires us to read the whole document. Can we limit our ranges
    // instead?
    const completePrefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position))
    const completeSuffix = document.getText(new vscode.Range(position, document.positionAt(document.getText().length)))

    // Patch the document to contain the selected completion from the popup dialog already
    let completePrefixWithContextCompletion = completePrefix
    let injectedPrefix = null
    if (context?.selectedCompletionInfo) {
        const { range, text } = context.selectedCompletionInfo
        completePrefixWithContextCompletion = completePrefix.slice(0, range.start.character - position.character) + text
        injectedPrefix = completePrefixWithContextCompletion.slice(completePrefix.length)
        if (injectedPrefix === '') {
            injectedPrefix = null
        }
    }

    const prefixLines = lines(completePrefixWithContextCompletion)
    const suffixLines = lines(completeSuffix)

    const currentLinePrefix = prefixLines.at(-1)!
    const currentLineSuffix = suffixLines[0]

    let prefix: string
    if (offset > maxPrefixLength) {
        let total = 0
        let startLine = prefixLines.length
        for (let i = prefixLines.length - 1; i >= 0; i--) {
            if (total + prefixLines[i].length > maxPrefixLength) {
                break
            }
            startLine = i
            total += prefixLines[i].length
        }
        prefix = prefixLines.slice(startLine).join('\n')
    } else {
        prefix = prefixLines.join('\n')
    }

    const semanticContextWithinDoc = getSemanticContextWithinDocument(document, position, 5)
    const semanticContext: string = semanticContextWithinDoc.semanticContext.join('\n')

    let totalSuffix = 0
    let endLine = 0
    for (let i = 0; i < suffixLines.length; i++) {
        if (totalSuffix + suffixLines[i].length > maxSuffixLength) {
            break
        }
        endLine = i + 1
        totalSuffix += suffixLines[i].length
    }
    const suffix = suffixLines.slice(0, endLine).join('\n')

    const prevNonEmptyLine = getPrevNonEmptyLine(prefix)
    const nextNonEmptyLine = getNextNonEmptyLine(suffix)

    const docContext = {
        prefix,
        suffix,
        contextRange: new vscode.Range(
            document.positionAt(offset - prefix.length),
            document.positionAt(offset + suffix.length)
        ),
        currentLinePrefix,
        currentLineSuffix,
        semanticContext,
        prevNonEmptyLine,
        nextNonEmptyLine,
        injectedPrefix,
    }

    return {
        ...docContext,
        multilineTrigger: detectMultiline({ docContext, document, enableExtendedTriggers, syntacticTriggers }),
    }
}
