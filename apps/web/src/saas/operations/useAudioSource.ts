import { useEffect, useState } from 'react'
export function useAudioSource(upload?: { name: string; base64: string }, saved?: string) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!upload) { setUrl(saved || ''); return }
    const extension = upload.name.split('.').at(-1)?.toLowerCase()
    const type = extension === 'wav' ? 'audio/wav' : extension === 'm4a' ? 'audio/mp4' : 'audio/mpeg'
    const bytes = Uint8Array.from(atob(upload.base64), c => c.charCodeAt(0))
    const source = URL.createObjectURL(new Blob([bytes], { type }))
    setUrl(source)
    return () => URL.revokeObjectURL(source)
  }, [upload, saved])
  return url
}
