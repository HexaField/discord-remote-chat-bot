export const vttToTranscriptLines = (vtt: string): string[] => {
  const lines = vtt.split(/\r?\n/)
  const cleaned: string[] = []

  for (const line of lines) {
    if (!line || line.startsWith('WEBVTT')) continue
    if (line.includes('-->')) continue
    if (/^\d+$/.test(line.trim())) continue
    const stripped = line
      .replace(/<v\s+[^>]+>/gi, '')
      .replace(/<\/v>/gi, '')
      .trim()
    if (stripped) cleaned.push(stripped)
  }

  return cleaned
}

export const vttToTranscript = (vtt: string): string => vttToTranscriptLines(vtt).join('\n')
