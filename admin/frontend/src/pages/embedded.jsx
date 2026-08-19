import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ExternalLink, Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import { openExternal } from '../lib/bot.js'

// 嵌入式 WebUI 页：在控制台内嵌打开 NapCat / AstrBot / 插件 WebUI。
export function EmbeddedWebUiPage({ target, onClose, onMinimize }) {
  const [frameKey, setFrameKey] = useState(0)
  const [loadedUrl, setLoadedUrl] = useState('')
  const loading = loadedUrl !== target.url

  const refresh = () => {
    setLoadedUrl('')
    setFrameKey((key) => key + 1)
  }

  return <section className="embedded-webui-page" aria-label={target.title}>
    <div className="embedded-webui-toolbar">
      <div className="embedded-webui-title"><button type="button" className="embedded-webui-back" onClick={onClose}><ChevronLeft size={15} />返回控制台</button><span>{target.title}</span></div>
      <div className="embedded-webui-actions"><button type="button" className="soft-button embedded-webui-minimize" onClick={onMinimize} aria-label="收起为悬浮球" data-tooltip="收起为悬浮球"><Minimize2 size={14} /></button><button type="button" className="soft-button" onClick={refresh} aria-label="刷新 WebUI" data-tooltip="刷新"><RefreshCw size={14} /></button><button type="button" className="soft-button embedded-webui-external" onClick={() => openExternal(target.url)}><ExternalLink size={13} />外部打开</button></div>
    </div>
    <div className="embedded-webui-frame-wrap">
      {loading && <div className="embedded-webui-loading">正在加载 {target.kind === 'napcat' ? 'NapCat WebUI' : target.kind === 'astrbot' ? 'AstrBot WebUI' : target.title}…</div>}
      <iframe key={`${target.url}-${frameKey}`} title={target.title} src={target.url} onLoad={() => setLoadedUrl(target.url)} />
    </div>
  </section>
}

const FLOATING_BUBBLE_SIZE = 48
const FLOATING_BUBBLE_GAP = 14
const FLOATING_BUBBLE_VISIBLE = FLOATING_BUBBLE_SIZE / 2

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function initialBubblePosition() {
  return {
    left: window.innerWidth - FLOATING_BUBBLE_VISIBLE,
    top: Math.max(FLOATING_BUBBLE_GAP, window.innerHeight - FLOATING_BUBBLE_SIZE - 28),
  }
}

export function EmbeddedWebUiBubble({ target, onOpen }) {
  const [position, setPosition] = useState(initialBubblePosition)
  const [snappedEdge, setSnappedEdge] = useState('right')
  const [dragging, setDragging] = useState(false)
  const positionRef = useRef(position)
  const dragRef = useRef({ active: false, moved: false, offsetX: 0, offsetY: 0, pointerId: null })
  const suppressClickRef = useRef(false)

  const updatePosition = useCallback((nextPosition) => {
    positionRef.current = nextPosition
    setPosition(nextPosition)
  }, [])

  const snapToEdge = useCallback((left, top) => {
    const edge = left + FLOATING_BUBBLE_SIZE / 2 < window.innerWidth / 2 ? 'left' : 'right'
    const nextLeft = edge === 'left' ? -FLOATING_BUBBLE_VISIBLE : window.innerWidth - FLOATING_BUBBLE_VISIBLE
    const nextTop = clamp(top, FLOATING_BUBBLE_GAP, window.innerHeight - FLOATING_BUBBLE_SIZE - FLOATING_BUBBLE_GAP)
    updatePosition({ left: nextLeft, top: nextTop })
    setSnappedEdge(edge)
  }, [updatePosition])

  useEffect(() => {
    const handleResize = () => {
      const current = positionRef.current
      if (snappedEdge) {
        snapToEdge(current.left, current.top)
        return
      }
      updatePosition({
        left: clamp(current.left, FLOATING_BUBBLE_GAP, window.innerWidth - FLOATING_BUBBLE_SIZE - FLOATING_BUBBLE_GAP),
        top: clamp(current.top, FLOATING_BUBBLE_GAP, window.innerHeight - FLOATING_BUBBLE_SIZE - FLOATING_BUBBLE_GAP),
      })
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [snappedEdge, snapToEdge, updatePosition])

  const handlePointerDown = (event) => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      active: true,
      moved: false,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      pointerId: event.pointerId,
    }
    suppressClickRef.current = false
    setSnappedEdge(null)
    setDragging(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handlePointerMove = (event) => {
    const drag = dragRef.current
    if (!drag.active || drag.pointerId !== event.pointerId) return
    const nextPosition = {
      left: clamp(event.clientX - drag.offsetX, FLOATING_BUBBLE_GAP, window.innerWidth - FLOATING_BUBBLE_SIZE - FLOATING_BUBBLE_GAP),
      top: clamp(event.clientY - drag.offsetY, FLOATING_BUBBLE_GAP, window.innerHeight - FLOATING_BUBBLE_SIZE - FLOATING_BUBBLE_GAP),
    }
    if (Math.abs(nextPosition.left - positionRef.current.left) > 3 || Math.abs(nextPosition.top - positionRef.current.top) > 3) drag.moved = true
    updatePosition(nextPosition)
  }

  const handlePointerUp = (event) => {
    const drag = dragRef.current
    if (!drag.active || drag.pointerId !== event.pointerId) return
    drag.active = false
    setDragging(false)
    if (drag.moved) {
      suppressClickRef.current = true
      snapToEdge(positionRef.current.left, positionRef.current.top)
    } else {
      snapToEdge(positionRef.current.left, positionRef.current.top)
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const handleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    onOpen()
  }

  return <button
    type="button"
    className={`embedded-webui-fab ${snappedEdge ? `snapped-${snappedEdge}` : ''} ${dragging ? 'dragging' : ''}`.trim()}
    style={{ left: `${position.left}px`, top: `${position.top}px` }}
    onPointerDown={handlePointerDown}
    onPointerMove={handlePointerMove}
    onPointerUp={handlePointerUp}
    onPointerCancel={handlePointerUp}
    onClick={handleClick}
    aria-label={`打开${target.title}`}
    data-tooltip={`打开${target.title}`}
  ><span className="embedded-webui-gel" aria-hidden="true"><span className="embedded-webui-core" /><span className="embedded-webui-liquid" /></span><Maximize2 size={18} /></button>
}
