import { useRef, useState } from 'react'

function getCurrentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 30000 },
    )
  })
}

export default function CameraWatermark({ onCapture, capturedEvidence }) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  async function handleFile(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const isImage = file.type.startsWith('image/')
    const isVideo = file.type.startsWith('video/')
    if (!isImage && !isVideo) {
      setNotice('Choose a photo or video from the camera or gallery.')
      return
    }
    if (file.size > (isVideo ? 8 : 4) * 1024 * 1024) {
      setNotice(isVideo ? 'Choose a video smaller than 8 MB.' : 'Choose a photo smaller than 4 MB.')
      return
    }

    setBusy(true)
    try {
      const capturedAtUtc = new Date().toISOString()
      let dataUrl
      let position = null
      if (isImage) {
        setNotice('Allow location access if you want the photo marked. You can continue without it.')
        position = await getCurrentPosition()
        const image = await createImageBitmap(file)
        const scale = Math.min(1, 1280 / image.width, 1280 / image.height)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(image.width * scale)
        canvas.height = Math.round(image.height * scale)
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const lines = [`Captured (UTC): ${capturedAtUtc}`, position ? `Location: ${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}` : 'Location: not shared', 'Worker-submitted evidence • not independently verified']
        const fontSize = Math.max(14, Math.round(canvas.width / 46))
        const lineHeight = Math.round(fontSize * 1.45)
        const padding = Math.round(fontSize * 0.8)
        const overlayHeight = lines.length * lineHeight + padding * 2
        context.fillStyle = 'rgba(0, 0, 0, 0.66)'
        context.fillRect(0, canvas.height - overlayHeight, canvas.width, overlayHeight)
        context.fillStyle = '#ffffff'
        context.font = `${fontSize}px sans-serif`
        lines.forEach((line, index) => context.fillText(line, padding, canvas.height - overlayHeight + padding + fontSize + index * lineHeight))
        dataUrl = canvas.toDataURL('image/jpeg', 0.78)
        image.close?.()
      } else {
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
      }
      onCapture({ dataUrl, mediaType: isImage ? 'image' : 'video', fileName: file.name, ...position, capturedAtUtc })
      setNotice(isVideo ? 'Video saved for assessor review. The original video is not independently verified.' : position ? 'Photo saved with UTC time and device-reported location.' : 'Photo saved with UTC time. Location was not shared.')
    } catch {
      setNotice('Could not prepare this image. Try another photo.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="camera-evidence">
      <div className="camera-copy">
        <strong>Optional photo or video evidence</strong>
        <small>Photos include a UTC timestamp and optional device-reported location. Uploaded media is worker-submitted and is not independently verified.</small>
      </div>
      <input ref={inputRef} type="file" accept="image/*,video/mp4,video/webm,video/quicktime" capture="environment" onChange={handleFile} hidden />
      <button className="camera-button" type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? 'Preparing evidence…' : capturedEvidence ? 'Replace evidence' : 'Take or choose photo/video'}
      </button>
      {capturedEvidence?.mediaType === 'video' && <video className="evidence-preview" src={capturedEvidence.dataUrl} controls preload="metadata" aria-label="Worker-submitted video evidence preview" />}
      {capturedEvidence?.mediaType !== 'video' && capturedEvidence && <img className="evidence-preview" src={capturedEvidence.dataUrl} alt="Worker-submitted photo with UTC time and optional location overlay" />}
      {notice && <small className="camera-notice" role="status">{notice}</small>}
    </div>
  )
}
