const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const animate = (a, b, duration, ease, render) => new Promise(resolve => {
    let start
    const step = now => {
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve()
    }
    requestAnimationFrame(step)
})

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect) => {
    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            // it's visible if any part of it is in view
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        sel.removeAllRanges()
        if (collapse === -1) range.collapse(true)
        else if (collapse === 1) range.collapse()
        sel.addRange(range)
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserver(() => this.expand())
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #layout = {}
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        return new Promise(resolve => {
            this.#iframe.addEventListener('load', () => {
                const doc = this.document
                afterLoad?.(doc)

                // it needs to be visible for Firefox to get computed style
                this.#iframe.style.display = 'block'
                const { vertical, rtl } = getDirection(doc)
                this.docBackground = getBackground(doc)
                doc.body.style.background = 'none'
                const background = this.docBackground
                this.#iframe.style.display = 'none'

                this.#vertical = vertical
                this.#rtl = rtl

                this.#contentRange.selectNodeContents(doc.body)
                const layout = beforeRender?.({ vertical, rtl, background })
                this.#iframe.style.display = 'block'
                this.render(layout)
                this.#observer.observe(doc.body)

                // the resize observer above doesn't work in Firefox
                // (see https://bugzilla.mozilla.org/show_bug.cgi?id=1832939)
                // until the bug is fixed we can at least account for font load
                doc.fonts.ready.then(() => this.expand())

                resolve()
            }, { once: true })
            this.#iframe.src = src
        })
    }
    render(layout) {
        if (!layout || !this.document) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ margin, gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${margin*1.5}px ${gap}px` : `0 ${gap}px`,
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, margin, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width

        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': vertical ? `${margin}px` : `${gap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'padding': vertical ? `${margin / 2}px ${gap}px` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            // preserve max size if they are already set
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - margin * 2}px`,
                'max-width': vertical
                    ? `${width - margin * 2}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
        }
    }
    expand() {
        const { documentElement } = this.document
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const contentSize = documentElement.getBoundingClientRect()[side]
            const expandedSize = contentSize
            const { margin, gap } = this.#layout
            const padding = this.#vertical ? `0 ${gap}px` : `${margin}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        if (this.document) this.#observer.unobserve(this.document.body)
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'max-inline-size', 'max-block-size', 'max-column-count',
    ]
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #lastVisibleRange
    // ── Stacked-scrolled mode (multi-section continuous scroll) ──
    // Upstream foliate only shows one section at a time in scrolled
    // flow. We modify: in scrolled flow, mount a host div per section
    // into #container, mount View instances into the hosts in a
    // sliding window around the current focal section, and let native
    // browser scroll flow across section boundaries. `#view` tracks the
    // focal section so all existing single-view code paths still work.
    #stacked = false           // true once #initStack() has run for a book
    #hosts = []                // one div per section, in book order
    #views = new Map()         // section index → View (only mounted ones)
    #heights = []              // measured content height per section
    #mountPromises = new Map() // in-flight mount avoids duplication
    #focalIdx = -1             // current focal section (viewport midpoint)
    #windowRadius = 1          // mount [focal-R, focal+R]
    #stackScrollHandler = null
    #programmaticScroll = false // suppresses focal-update during scrollTo
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(var(--_half-gap), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(var(--_half-gap), 1fr);
            grid-template-rows:
                minmax(var(--_margin), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 2;
            overflow: hidden;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            overflow: auto;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header, #footer {
            display: grid;
            height: var(--_margin);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container" part="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => this.dispatchEvent(new Event('scroll')))
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled) {
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
            }
        }, 250))

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            doc.addEventListener('pointerdown', () => isPointerSelecting = true)
            doc.addEventListener('pointerup', () => isPointerSelecting = false)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                if (isPointerSelecting && sel.type === 'Range')
                    checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => this.scrolled ? null :
                // NOTE: `requestAnimationFrame` is needed in WebKit
                requestAnimationFrame(() => this.#scrollToAnchor(e.target)))
        })

        this.#mediaQueryListener = () => {
            if (!this.#view) return
            this.#replaceBackground(this.#view.docBackground, this.columnCount)
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                // Flow toggles between paginated and scrolled. If we
                // have a book open, build or tear down the section
                // stack accordingly. Position is preserved via the
                // current #index + #anchor (foliate's existing fields).
                if (this.sections) {
                    if (value === 'scrolled' && !this.#stacked)
                        this.#initStack()
                    else if (value !== 'scrolled' && this.#stacked)
                        this.#teardownStack()
                }
                this.render()
                break
            case 'gap':
            case 'margin':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        // If flow was set to scrolled before open, initialize the
        // stack now that sections are available.
        if (this.scrolled && !this.#stacked) this.#initStack()
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/(?<=[{\s;])-epub-/gi, '')
                // replace vw and vh as they cause problems with layout
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #createView(stackedIndex) {
        // Stacked path: mount the view into the section's host div.
        // Paginated path: do the upstream single-view teardown-and-
        // reattach against #container.
        if (stackedIndex != null) {
            const host = this.#hosts[stackedIndex]
            const existing = this.#views.get(stackedIndex)
            if (existing) {
                existing.destroy()
                host?.removeChild(existing.element)
            }
            const view = new View({
                container: this,
                onExpand: () => {
                    this.#measureSection(stackedIndex)
                    // Only re-anchor if this section is the focal one,
                    // else a neighbor reflow (image decode, font load)
                    // would jerk the viewport mid-scroll.
                    if (stackedIndex === this.#focalIdx)
                        this.#scrollToAnchor(this.#anchor)
                },
            })
            host?.append(view.element)
            this.#views.set(stackedIndex, view)
            this.#view = view
            return view
        }
        if (this.#view) {
            this.#view.destroy()
            this.#container.removeChild(this.#view.element)
        }
        this.#view = new View({
            container: this,
            onExpand: () => this.#scrollToAnchor(this.#anchor),
        })
        this.#container.append(this.#view.element)
        return this.#view
    }
    #replaceBackground(background, columnCount) {
        const doc = this.#view?.document
        if (!doc) return
        const htmlStyle = doc.defaultView.getComputedStyle(doc.documentElement)
        const themeBgColor = htmlStyle.getPropertyValue('--theme-bg-color')
        if (background && themeBgColor) {
            const parsedBackground = background.split(/\s(?=(?:url|rgb|hsl|#[0-9a-fA-F]{3,6}))/)
            parsedBackground[0] = themeBgColor
            background = parsedBackground.join(' ')
        }
        if (/cover.*fixed|fixed.*cover/.test(background)) {
            background = background.replace('cover', 'auto 100%').replace('fixed', '')
        }
        this.#background.innerHTML = ''
        this.#background.style.display = 'grid'
        this.#background.style.gridTemplateColumns = `repeat(${columnCount}, 1fr)`
        for (let i = 0; i < columnCount; i++) {
            const column = document.createElement('div')
            column.style.background = background
            column.style.width = '100%'
            column.style.height = '100%'
            this.#background.appendChild(column)
        }
    }
    #beforeRender({ vertical, rtl, background }) {
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin'))
        this.#margin = margin

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return { flow, margin, gap, columnWidth }
        }

        const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
        const columnWidth = vertical ? (size / divisor - margin) : (size / divisor - gap)
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        this.columnCount = divisor
        this.#replaceBackground(background, this.columnCount)

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(width / maxInlineSize))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { height, width, margin, gap, columnWidth }
    }
    render() {
        if (this.#stacked) {
            // Re-render every mounted section — each View's internal
            // layout depends on #container size, so a container resize
            // (window rotation, font size change) must reach them all.
            const layout = this.#beforeRender({
                vertical: this.#vertical,
                rtl: this.#rtl,
            })
            for (const [idx, view] of this.#views) {
                view.render(layout)
                this.#measureSection(idx)
            }
            // Re-anchor: keep focal reading position stable across the
            // reflow. Skip if no anchor has been set yet (pre-first-goTo).
            if (this.#anchor !== undefined) this.#scrollToAnchor(this.#anchor)
            return
        }
        if (!this.#view) return
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        this.#scrollToAnchor(this.#anchor)
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    // Live-reading exposure for stacked scroll mode. reader.ts uses
    // these to compute book-level fraction during a drag, matching
    // what view.js's sectionProgress wrap would produce post-scroll.
    get focalIndex() {
        return this.#stacked ? this.#focalIdx : this.#index
    }
    get focalLocalFraction() {
        if (!this.#stacked) return 0
        const host = this.#hosts[this.#focalIdx]
        const h = this.#heights[this.#focalIdx]
            || host?.getBoundingClientRect().height || 0
        if (!host || h <= 0) return 0
        const local = this.start - host.offsetTop
        return Math.max(0, Math.min(1, local / h))
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        // Stacked scrolled mode: view spans the entire #container
        // scroll height — fraction = start / viewSize becomes the
        // global book fraction, which is what relocate should emit.
        if (this.#stacked)
            return this.#vertical
                ? this.#container.scrollWidth
                : this.#container.scrollHeight
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        return Math.abs(this.#container[this.scrollProp])
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        if (this.#stacked) {
            // Focal-section-relative page (1-indexed) so the reader's
            // "page X / pagesInSection" math matches paginated semantics.
            const host = this.#hosts[this.#focalIdx]
            if (!host) return 1
            const local = (this.start + this.size / 2) - host.offsetTop
            return Math.max(1, Math.floor(local / this.size) + 1)
        }
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        if (this.#stacked) {
            const h = this.#heights[this.#focalIdx]
                || this.#hosts[this.#focalIdx]?.getBoundingClientRect().height
                || 0
            return Math.max(1, Math.round(h / this.size))
        }
        return Math.round(this.viewSize / this.size)
    }
    // this is the current position of the container
    get containerPosition() {
        return this.#container[this.scrollProp]
    }

    // this is the new position of the containr
    set containerPosition(newVal) {
        this.#container[this.scrollProp] = newVal
    }

    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        this.containerPosition = Math.max(min, Math.min(max,
            this.containerPosition + delta))
    }

    snap(vx, vy) {
        const velocity = this.#vertical ? vy : vx
        const [offset, a, b] = this.#scrollBounds
        const { start, end, pages, size } = this
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const d = velocity * (this.#rtl ? -size : size)
        const page = Math.floor(
            Math.max(min, Math.min(max, (start + end) / 2
                + (isNaN(d) ? 0 : d))) / size)

        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir) return this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        })
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, xy: 0,
        }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (this.scrolled || state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        const doc = this.#view?.document
        const selection = doc?.getSelection()
        if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
            return
        }
        e.preventDefault()
        const touch = e.changedTouches[0]
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        this.#touchScrolled = true
        if (Math.abs(dx) >= Math.abs(dy)) {
            this.scrollBy(dx, 0)
        } else if (Math.abs(dy) > Math.abs(dx)) {
            this.scrollBy(0, dy)
        }
    }
    #onTouchEnd() {
        this.#touchScrolled = false
        if (this.scrolled) return

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        requestAnimationFrame(() => {
            if (globalThis.visualViewport.scale === 1)
                this.snap(this.#touchState.vx, this.#touchState.vy)
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper() {
        if (this.scrolled) {
            const size = this.viewSize
            const margin = this.#margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left - this.#margin
            return this.#scrollTo(offset, reason)
        }
        const offset = this.#getRectMapper()(rect).left
        return this.#scrollToPage(Math.floor(offset / this.size) + (this.#rtl ? -1 : 1), reason)
    }
    async #scrollTo(offset, reason, smooth) {
        const { size } = this
        if (this.containerPosition === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated')) return animate(
            this.containerPosition, offset, 300, easeOutQuad,
            x => this.containerPosition = x,
        ).then(() => {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        })
        else {
            this.containerPosition = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation')
    }
    async #scrollToAnchor(anchor, reason = 'anchor') {
        this.#anchor = anchor
        // Stacked scrolled mode: anchor may be a Range/Element living
        // in one of the mounted section iframes. The rect's top is
        // relative to that iframe, so translate via iframe.getBoundingClientRect
        // and #container.getBoundingClientRect to outer-scroll coords.
        if (this.#stacked) {
            const rects = uncollapse(anchor)?.getClientRects?.()
            if (rects) {
                const rect = Array.from(rects).find(r => r.width > 0 && r.height > 0) || rects[0]
                if (!rect) return
                // Find which iframe the anchor lives in.
                const owner = uncollapse(anchor)?.startContainer?.ownerDocument
                    ?? (anchor?.ownerDocument)
                const iframe = owner?.defaultView?.frameElement
                if (!iframe) return
                const irect = iframe.getBoundingClientRect()
                const crect = this.#container.getBoundingClientRect()
                const absTop = (irect.top - crect.top) + this.#container.scrollTop + rect.top
                this.#programmaticScroll = true
                await this.#scrollTo(Math.max(0, absTop - this.#margin), reason)
                this.#programmaticScroll = false
                return
            }
            // Fractional anchor is section-relative (same semantics as
            // upstream: 0 = top of section, 1 = end of section). Maps to
            // host.offsetTop + frac * host.height in outer-scroll coords.
            const idx = this.#focalIdx >= 0 ? this.#focalIdx
                : (typeof this.#index === 'number' && this.#index >= 0 ? this.#index : 0)
            const host = this.#hosts[idx]
            if (!host) return
            const hostH = this.#heights[idx] || host.getBoundingClientRect().height || 0
            this.#programmaticScroll = true
            await this.#scrollTo(host.offsetTop + (anchor ?? 0) * hostH, reason)
            this.#programmaticScroll = false
            return
        }
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            if (!rect) return
            await this.#scrollToRect(rect, reason)
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            await this.#scrollTo(anchor * this.viewSize, reason)
            return
        }
        const { pages } = this
        if (!pages) return
        const textPages = pages - 2
        const newPage = Math.round(anchor * (textPages - 1))
        await this.#scrollToPage(newPage + 1, reason)
    }
    #getVisibleRange() {
        if (this.#stacked) {
            // Translate the #container viewport range into coordinates
            // local to the focal section's iframe. getVisibleRange walks
            // text nodes inside that single doc, so negative/out-of-range
            // local bounds just return empty — exactly what we want.
            const view = this.#views.get(this.#focalIdx) ?? this.#view
            const doc = view?.document
            if (!doc) return
            const iframe = doc.defaultView?.frameElement
            if (!iframe) return
            const crect = this.#container.getBoundingClientRect()
            const irect = iframe.getBoundingClientRect()
            // top of iframe in container-viewport coords
            const iframeTopInViewport = irect.top - crect.top
            // Visible local range inside the iframe's own coordinates:
            const localTop = Math.max(0, -iframeTopInViewport)
            const localBottom = Math.min(iframe.offsetHeight || irect.height, crect.height - iframeTopInViewport)
            return getVisibleRange(doc, localTop + this.#margin, localBottom - this.#margin, this.#getRectMapper())
        }
        if (this.scrolled) return getVisibleRange(this.#view.document,
            this.start + this.#margin, this.end - this.#margin, this.#getRectMapper())
        const size = this.#rtl ? -this.size : this.size
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper())
    }
    #afterScroll(reason) {
        const range = this.#getVisibleRange()
        this.#lastVisibleRange = range
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else this.#justAnchored = true

        const index = this.#index
        const detail = { reason, range, index }
        if (this.scrolled) {
            // Stacked mode: report SECTION-RELATIVE fraction so view.js's
            // sectionProgress wrap can byte-weight it into a book-level
            // fraction the same way it does for paginated flow. Using
            // pixel-uniform `start/viewSize` here would feed sectionProgress
            // a value it interprets as section-relative, double-weighting
            // and producing a different fraction than mid-scroll.
            if (this.#stacked) {
                const host = this.#hosts[this.#focalIdx]
                const h = this.#heights[this.#focalIdx]
                    || host?.getBoundingClientRect().height || 0
                const local = host ? (this.start - host.offsetTop) : 0
                detail.fraction = h > 0
                    ? Math.max(0, Math.min(1, local / h))
                    : 0
            } else detail.fraction = this.start / this.viewSize
        }
        else if (this.pages > 0) {
            const { page, pages } = this
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            detail.fraction = (page - 1) / (pages - 2)
            detail.size = 1 / (pages - 2)
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    async #display(promise) {
        const { index, src, anchor, onLoad, select } = await promise
        this.#index = index
        if (this.#stacked) {
            // Mount the section (idempotent) and make it focal. Scroll
            // to the anchor inside the outer continuous container.
            this.#focalIdx = index
            await this.#mountSection(index, { src, onLoad })
            // Prime the window so neighbors are ready before user scrolls.
            void this.#slideWindow(index)
            const view = this.#views.get(index)
            if (!view) return
            const hasFocus = view.document?.hasFocus()
            this.#view = view
            await this.#scrollToAnchor((typeof anchor === 'function'
                ? anchor(view.document) : anchor) ?? 0, 'navigation')
            if (hasFocus) this.focusView()
            return
        }
        const hasFocus = this.#view?.document?.hasFocus()
        if (src) {
            const view = this.#createView()
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                onLoad?.({ doc, index })
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, afterLoad, beforeRender)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            this.#view = view
        }
        await this.scrollToAnchor((typeof anchor === 'function'
            ? anchor(this.#view.document) : anchor) ?? 0, select)
        if (hasFocus) this.focusView()
    }
    // ── Stack management (scrolled flow, multi-section) ──────────────
    #estSectionHeight() {
        const h = this.#container.clientHeight || 800
        return Math.max(600, Math.floor(h * 1.5))
    }
    #initStack() {
        if (this.#stacked || !this.sections) return
        this.#stacked = true
        // Tear down any leftover single-view child of #container.
        if (this.#view?.element?.parentNode === this.#container) {
            this.#view.destroy()
            this.#container.removeChild(this.#view.element)
            this.#view = null
        }
        this.#hosts = []
        this.#views = new Map()
        this.#heights = new Array(this.sections.length).fill(0)
        const estH = this.#estSectionHeight()
        for (let i = 0; i < this.sections.length; i++) {
            const host = document.createElement('div')
            host.dataset.sectionIndex = String(i)
            // content-visibility: auto skips rendering offscreen hosts.
            // contain-intrinsic-size gives the scrollbar a stable total
            // before the host has been measured. min-height keeps space
            // reserved even when the host becomes offscreen + skipped.
            host.style.cssText =
                `display:block;width:100%;min-height:${estH}px;` +
                `content-visibility:auto;contain-intrinsic-size:0 ${estH}px;` +
                `position:relative;`
            this.#container.appendChild(host)
            this.#hosts.push(host)
        }
        this.#stackScrollHandler = () => this.#onStackScroll()
        this.#container.addEventListener('scroll',
            this.#stackScrollHandler, { passive: true })
    }
    #teardownStack() {
        if (!this.#stacked) return
        if (this.#stackScrollHandler) {
            this.#container.removeEventListener('scroll', this.#stackScrollHandler)
            this.#stackScrollHandler = null
        }
        for (const [, v] of this.#views) {
            try { v.destroy() } catch { /* ignore */ }
        }
        this.#views = new Map()
        this.#hosts = []
        this.#heights = []
        this.#mountPromises.clear()
        this.#container.innerHTML = ''
        this.#stacked = false
        this.#focalIdx = -1
        this.#view = null
        // Paginated render will re-create a single view via #goTo.
    }
    async #mountSection(index, opts = {}) {
        if (index < 0 || index >= this.#hosts.length) return
        if (this.#views.has(index)) return
        const pending = this.#mountPromises.get(index)
        if (pending) return pending
        const task = (async () => {
            const src = opts.src ?? await Promise.resolve(this.sections[index].load())
                .catch(e => { console.warn(e); return null })
            if (!src) return
            const view = this.#createView(index)
            const afterLoad = doc => {
                if (doc.head) {
                    const sb = doc.createElement('style'); doc.head.prepend(sb)
                    const st = doc.createElement('style'); doc.head.append(st)
                    this.#styleMap.set(doc, [sb, st])
                }
                opts.onLoad?.({ doc, index })
                this.dispatchEvent(new CustomEvent('load', {
                    detail: { doc, index },
                }))
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, afterLoad, beforeRender)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            // Apply current styles to the newly-loaded doc so all
            // stacked sections render with the active theme.
            this.#applyStylesToDoc(view.document)
            this.#measureSection(index)
        })()
        this.#mountPromises.set(index, task)
        try { await task } finally { this.#mountPromises.delete(index) }
    }
    #unmountSection(index) {
        const view = this.#views.get(index)
        if (!view) return
        try { view.destroy() } catch { /* ignore */ }
        const host = this.#hosts[index]
        if (host) host.innerHTML = ''
        this.#views.delete(index)
        // Host retains its cached height (min-height + contain-intrinsic-
        // size) so the scrollbar doesn't jump when we release this view.
    }
    async #slideWindow(focal) {
        const R = this.#windowRadius
        const lo = Math.max(0, focal - R)
        const hi = Math.min(this.#hosts.length - 1, focal + R)
        for (const k of Array.from(this.#views.keys())) {
            if (k < lo || k > hi) this.#unmountSection(k)
        }
        const toMount = []
        for (let i = lo; i <= hi; i++) {
            if (!this.#views.has(i) && !this.#mountPromises.has(i))
                toMount.push(this.#mountSection(i))
        }
        if (toMount.length > 0) await Promise.all(toMount)
    }
    #measureSection(index) {
        const view = this.#views.get(index)
        const host = this.#hosts[index]
        if (!view || !host) return
        const doc = view.document
        if (!doc) return
        let h = 0
        try {
            h = Math.max(
                doc.body?.scrollHeight ?? 0,
                doc.documentElement?.scrollHeight ?? 0,
                view.element.getBoundingClientRect().height || 0,
            )
        } catch { return }
        if (h <= 0) return
        // Floor to one viewport so a tiny section (title page, half
        // title) still occupies a full screen — keeps each section
        // visually distinct and the scrubber feel consistent.
        h = Math.max(h, this.size)
        const prev = this.#heights[index] || 0
        if (Math.abs(h - prev) < 2) return
        // Compensate scroll position so content above the viewport
        // resizing doesn't shove the user downstream visually.
        const hostRect = host.getBoundingClientRect()
        const crect = this.#container.getBoundingClientRect()
        const above = hostRect.bottom <= crect.top
        this.#heights[index] = h
        // Pin host to exact measured content height: scrollbar math
        // stays stable and the host doesn't grow/shrink when a
        // neighbor's View resizes itself on image decode.
        host.style.minHeight = ''
        host.style.height = h + 'px'
        host.style.containIntrinsicSize = `0 ${h}px`
        if (above) {
            this.#programmaticScroll = true
            this.#container.scrollTop += (h - prev)
            this.#programmaticScroll = false
        }
    }
    #applyStylesToDoc(doc) {
        const styles = this.#styles
        const pair = this.#styleMap.get(doc)
        if (!pair || !styles) return
        const [sb, st] = pair
        if (Array.isArray(styles)) {
            sb.textContent = styles[0] || ''
            st.textContent = styles[1] || ''
        } else {
            st.textContent = styles
        }
    }
    #onStackScroll() {
        if (this.#programmaticScroll) return
        // Determine focal section by viewport midpoint of #container.
        const crect = this.#container.getBoundingClientRect()
        const mid = crect.top + crect.height / 2
        let focal = this.#focalIdx >= 0 ? this.#focalIdx : 0
        for (let i = 0; i < this.#hosts.length; i++) {
            const hr = this.#hosts[i].getBoundingClientRect()
            if (hr.top <= mid && hr.bottom >= mid) { focal = i; break }
            if (hr.top > mid) { focal = Math.max(0, i - 1); break }
            focal = i
        }
        const changed = focal !== this.#focalIdx
        this.#focalIdx = focal
        const view = this.#views.get(focal)
        if (view) {
            this.#view = view
            this.#index = focal
        }
        if (changed) void this.#slideWindow(focal)
        // The debounced scroll handler in the constructor will fire
        // #afterScroll('scroll') which reads fraction from viewSize/
        // start — those getters are stack-aware when #stacked is true.
    }
    // ─────────────────────────────────────────────────────────────────
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo({ index, anchor, select }) {
        if (this.#stacked) {
            // No tear-down-and-rebuild: mountSection is idempotent.
            // #display will mount (if needed), set focal, slide window,
            // scroll to the anchor, and our overlay/load events fire
            // from #mountSection the first time around.
            await this.#display(Promise.resolve({ index, anchor, select }))
            return
        }
        if (index === this.#index) await this.#display({ index, anchor, select })
        else {
            const oldIndex = this.#index
            const onLoad = detail => {
                this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            await this.#display(Promise.resolve(this.sections[index].load())
                .then(src => ({ index, src, anchor, onLoad, select }))
                .catch(e => {
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    return {}
                }))
        }
    }
    async goTo(target) {
        if (this.#locked) return
        const resolved = await target
        if (this.#canGoToIndex(resolved.index)) return this.#goTo(resolved)
    }
    #scrollPrev(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.start > 0) return this.#scrollTo(
                Math.max(0, this.start - (distance ?? this.size)), null, true)
            return !this.atStart
        }
        if (this.atStart) return
        const page = this.page - 1
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    #scrollNext(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.viewSize - this.end > 2) return this.#scrollTo(
                Math.min(this.viewSize, distance ? this.start + distance : this.end), null, true)
            return !this.atEnd
        }
        if (this.atEnd) return
        const page = this.page + 1
        const pages = this.pages
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        return this.#adjacentIndex(-1) == null && this.page <= 1
    }
    get atEnd() {
        return this.#adjacentIndex(1) == null && this.page >= this.pages - 2
    }
    #adjacentIndex(dir) {
        for (let index = this.#index + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        this.#locked = true
        // Safety timeout: if any inner await throws or hangs (notably
        // #scrollToAnchor on section transitions), the lock would stay
        // set and ALL subsequent navigation would silently no-op. 300ms
        // is imperceptible as back-off and keeps the reader self-healing.
        const safety = setTimeout(() => { this.#locked = false }, 300)
        try {
            const prev = dir === -1
            const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
            if (shouldGo) await this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: prev ? () => 1 : () => 0,
            })
            if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        } finally {
            clearTimeout(safety)
            this.#locked = false
        }
    }
    async prev(distance) {
        return await this.#turnPage(-1, distance)
    }
    async next(distance) {
        return await this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getContents() {
        // Stacked mode returns every mounted section so selection/
        // annotation code can find the right iframe across boundaries.
        if (this.#stacked) {
            const out = []
            for (const [index, view] of this.#views) {
                if (view?.document) out.push({
                    index,
                    overlayer: view.overlayer,
                    doc: view.document,
                })
            }
            return out
        }
        if (this.#view) return [{
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }]
        return []
    }
    setStyles(styles) {
        this.#styles = styles
        if (this.#stacked) {
            // Push into every mounted section so the whole stack is
            // themed consistently — a section that mounted before the
            // user changed fonts would otherwise keep the old styles.
            for (const [idx, view] of this.#views) {
                this.#applyStylesToDoc(view.document)
                view.document?.fonts?.ready?.then(() => {
                    view.expand()
                    this.#measureSection(idx)
                })
            }
            return
        }
        const $$styles = this.#styleMap.get(this.#view?.document)
        if (!$$styles) return
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles

        // NOTE: needs `requestAnimationFrame` in Chromium.
        // Guard: #view can become null during teardown / pre-first-goTo.
        requestAnimationFrame(() => {
            if (this.#view) this.#replaceBackground(this.#view.docBackground, this.columnCount)
        })

        // needed because the resize observer doesn't work in Firefox
        this.#view?.document?.fonts?.ready?.then(() => this.#view.expand())
    }
    focusView() {
        this.#view.document.defaultView.focus()
    }
    destroy() {
        this.#observer.unobserve(this)
        if (this.#stacked) {
            if (this.#stackScrollHandler)
                this.#container.removeEventListener('scroll', this.#stackScrollHandler)
            for (const [, v] of this.#views) {
                try { v.destroy() } catch { /* ignore */ }
            }
            this.#views = new Map()
            for (const s of this.sections || []) s?.unload?.()
        } else {
            this.#view?.destroy()
            this.sections[this.#index]?.unload?.()
        }
        this.#view = null
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

customElements.define('foliate-paginator', Paginator)
