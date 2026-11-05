/**
 * HTML Document Validator (PHASE 1)
 * Detects duplicate document root tags (<!DOCTYPE>, <html>, <body>) caused by
 * models concatenating templates or appending new content to old content.
 */

export interface HtmlValidationResult {
  ok: boolean;
  error?: string;
  counts: {
    doctype: number;
    html: number;
    body: number;
  };
}

const DOCTYPE_RE = /<!DOCTYPE\s+html/gi;
const HTML_OPEN_RE = /<html(?:\s+[^>]*)?>/gi;
const BODY_OPEN_RE = /<body(?:\s+[^>]*)?>/gi;

/**
 * Validates that an HTML file does not contain duplicate document declarations.
 */
export function validateHtmlDocument(content: string): HtmlValidationResult {
  const doctypeMatches = content.match(DOCTYPE_RE) ?? [];
  const htmlMatches = content.match(HTML_OPEN_RE) ?? [];
  const bodyMatches = content.match(BODY_OPEN_RE) ?? [];

  const counts = {
    doctype: doctypeMatches.length,
    html: htmlMatches.length,
    body: bodyMatches.length,
  };

  const violations: string[] = [];
  if (counts.doctype > 1) {
    violations.push(`contains ${counts.doctype} <!DOCTYPE html> tags (expected at most 1)`);
  }
  if (counts.html > 1) {
    violations.push(`contains ${counts.html} <html> tags (expected at most 1)`);
  }
  if (counts.body > 1) {
    violations.push(`contains ${counts.body} <body> tags (expected at most 1)`);
  }

  if (violations.length > 0) {
    return {
      ok: false,
      error: `Invalid HTML document structure: ${violations.join(", ")}. Content was likely duplicated or concatenated.`,
      counts,
    };
  }

  return { ok: true, counts };
}

/**
 * Sanitizes an HTML string if a model accidentally emitted multiple concatenated
 * documents by keeping the last complete document declaration.
 */
export function sanitizeHtmlDocument(content: string): string {
  const validation = validateHtmlDocument(content);
  if (validation.ok) return content;

  // If there are multiple <!DOCTYPE html> declarations, take the last one
  const doctypeIndices: number[] = [];
  DOCTYPE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DOCTYPE_RE.exec(content)) !== null) {
    doctypeIndices.push(match.index);
  }

  if (doctypeIndices.length > 1) {
    const lastDoctype = doctypeIndices[doctypeIndices.length - 1];
    const candidate = content.slice(lastDoctype).trim();
    const candidateValidation = validateHtmlDocument(candidate);
    if (candidateValidation.ok) return candidate;
  }

  // If there are multiple <html> tags without doctype, take from the last <html>
  const htmlIndices: number[] = [];
  HTML_OPEN_RE.lastIndex = 0;
  while ((match = HTML_OPEN_RE.exec(content)) !== null) {
    htmlIndices.push(match.index);
  }
  if (htmlIndices.length > 1) {
    const lastHtml = htmlIndices[htmlIndices.length - 1];
    const candidate = content.slice(lastHtml).trim();
    const candidateValidation = validateHtmlDocument(candidate);
    if (candidateValidation.ok) return "<!DOCTYPE html>\n" + candidate;
  }

  return content;
}

