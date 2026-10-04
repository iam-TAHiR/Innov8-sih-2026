import { useEffect, useRef, useState } from 'react'

export default function VoiceInput({ language, onTranscriptChange }) {
  const recognitionRef = useRef(null)
  const [listening, setListening] = useState(false)
  const [message, setMessage] = useState('')
  const [supported, setSupported] = useState(true)

  useEffect(() => () => {
    recognitionRef.current?.abort?.()
  }, [])

  function toggleListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      setSupported(false)
      setMessage('Voice typing is not available in this browser. You can still type your statement.')
      return
    }
    if (listening) {
      recognitionRef.current?.stop()
      return
    }

    setMessage('')
    const recognition = new SpeechRecognition()
    recognition.lang = language
    recognition.interimResults = false
    recognition.continuous = false
    recognition.maxAlternatives = 1
    recognition.onstart = () => setListening(true)
    recognition.onend = () => setListening(false)
    recognition.onerror = (event) => {
      setListening(false)
      setMessage(event.error === 'not-allowed'
        ? 'Microphone access was denied. Allow it in the browser or type instead.'
        : 'Voice typing stopped. Try again or type instead.')
    }
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript?.trim())
        .filter(Boolean)
        .join(' ')
      if (transcript) onTranscriptChange(transcript)
    }
    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      setListening(false)
      setMessage('Could not start the microphone. Check browser permissions and try again.')
    }
  }

  return (
    <div className="voice-input">
      <button className={`voice-button ${listening ? 'listening' : ''}`} type="button" onClick={toggleListening} disabled={!supported && listening}>
        <span aria-hidden="true">🎙</span> {listening ? 'Stop listening' : 'Speak your experience'}
      </button>
      <span className="voice-hint">Voice typing may need an internet connection. Your text draft is saved on this device.</span>
      {message && <span className="voice-message" role="status">{message}</span>}
    </div>
  )
}
