// Keep the pre-existing non-video read behavior, but remove anonymous access to video objects.
export function privateVideoPolicy(bucket) {
  const base = `arn:aws:s3:::${bucket}/`
  const privatePatterns = [
    '*/ai/video/*',
    '*/office-edits/*',
    '*/agent/video-edit/*',
    '*/agent/aideo/*',
    '*/agent/drama-recap/*',
    '*/agent/style-transfer/*',
    ...['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpeg', 'mpg', 'ts', 'm3u8'].flatMap((ext) =>
      [...ext].reduce(
        (variants, char) =>
          variants.flatMap((prefix) =>
            [...new Set([char.toLowerCase(), char.toUpperCase()])].map((c) => prefix + c),
          ),
        ['*.'],
      ),
    ),
  ]
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: '*',
        Action: ['s3:GetObject'],
        NotResource: privatePatterns.map((pattern) => base + pattern),
      },
    ],
  }
}
