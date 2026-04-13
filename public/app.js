const socket = io();

// --- Core State ---
let workspaceData = { projects: [] };
let activeProjectId = null;
let activeWorkflowId = null;

let nodes = [];
let edges = [];
let selectedNodes = new Set(); 

// --- History Stack (Undo/Redo) ---
let historyStack = [];
let historyPointer = -1;

// --- View & Grid State ---
let transform = { scale: 1, panX: 0, panY: 0 };
let isPanning = false;
let startPan = { x: 0, y: 0 };
const GRID_SIZE = 20;

// --- Interaction State ---
let dragState = { isDragging: false, hasMoved: false, isMarquee: false, startX: 0, startY: 0, prevX: 0, prevY: 0 };
let connectionState = { isConnecting: false, fromNode: null, fromPort: null };

// --- DOM Elements ---
const DOM = {
    projectList: document.getElementById('project-list'),
    canvas: document.getElementById('canvas'),
    canvasContainer: document.getElementById('canvas-container'),
    svgLayer: document.getElementById('svg-layer'),
    toolbarTools: document.getElementById('toolbar-tools'),
    zoomLevel: document.getElementById('zoom-level'),
    marquee: document.getElementById('marquee'),
    minimap: document.getElementById('minimap'),
    minimapContent: document.getElementById('minimap-content'),
    minimapViewport: document.getElementById('minimap-viewport')
};

// Global Tooltip
const tooltipEl = document.createElement('div');
tooltipEl.className = 'node-tooltip';
DOM.canvasContainer.appendChild(tooltipEl);

// Professional Node Icons
const NodeIcons = {
    start: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><path d="M10 8l6 4-6 4V8z" fill="currentColor"></path></svg>`,
    end: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><rect x="9" y="9" width="6" height="6" fill="currentColor"></rect></svg>`,
    process: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M8 10h8M8 14h4"></path></svg>`,
    decision: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 22 12 12 22 2 12 12 2"></polygon></svg>`,
    input: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
    output: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`
};

// --- Initialization & Theme ---
document.getElementById('theme-selector').addEventListener('change', (e) => {
    const theme = e.target.value;
    if (theme === 'dark') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', theme);
    }
});

function initSvgDefs() {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--text-muted)" />
        </marker>
        <marker id="arrowhead-hover" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--accent)" />
        </marker>
    `;
    DOM.svgLayer.appendChild(defs);
}
initSvgDefs();

// --- Data & Sync ---
async function loadData() {
    const res = await fetch('/api/workspace');
    workspaceData = await res.json();
    renderSidebar();
}

function broadcastUpdate() {
    if (activeWorkflowId) updateCurrentWorkflowState();
    socket.emit('sync-update', workspaceData);
}

socket.on('workspace-updated', (newData) => {
    workspaceData = newData;
    renderSidebar();
    if (activeProjectId && activeWorkflowId) {
        const proj = workspaceData.projects.find(p => p.id === activeProjectId);
        if (proj && proj.workflows.find(w => w.id === activeWorkflowId)) {
            nodes = JSON.parse(JSON.stringify(proj.workflows.find(w => w.id === activeWorkflowId).nodes || []));
            edges = JSON.parse(JSON.stringify(proj.workflows.find(w => w.id === activeWorkflowId).edges || []));
            renderCanvas();
        } else {
            clearWorkspace();
        }
    }
});

function updateCurrentWorkflowState() {
    const proj = workspaceData.projects.find(p => p.id === activeProjectId);
    if (proj) {
        const wf = proj.workflows.find(w => w.id === activeWorkflowId);
        if (wf) {
            wf.nodes = nodes;
            wf.edges = edges;
        }
    }
}

// --- Undo / Redo & Keyboard Shortcuts ---
function pushHistory() {
    if (!activeWorkflowId) return;
    historyStack = historyStack.slice(0, historyPointer + 1);
    historyStack.push(JSON.parse(JSON.stringify({ nodes, edges })));
    if (historyStack.length > 50) historyStack.shift();
    historyPointer = historyStack.length - 1;
}

function undo() {
    if (historyPointer > 0) {
        historyPointer--;
        restoreState(historyStack[historyPointer]);
    }
}

function redo() {
    if (historyPointer < historyStack.length - 1) {
        historyPointer++;
        restoreState(historyStack[historyPointer]);
    }
}

function restoreState(state) {
    nodes = JSON.parse(JSON.stringify(state.nodes));
    edges = JSON.parse(JSON.stringify(state.edges));
    selectedNodes.clear();
    renderCanvas();
    broadcastUpdate();
}

document.getElementById('undo-btn').onclick = undo;
document.getElementById('redo-btn').onclick = redo;

document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); }

    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodes.size > 0) {
            pushHistory();
            selectedNodes.forEach(nodeId => {
                nodes = nodes.filter(n => n.id !== nodeId);
                edges = edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
            });
            selectedNodes.clear();
            renderCanvas();
            broadcastUpdate();
        }
    }
});

// --- Auto Layout (Dagre) ---
document.getElementById('auto-layout-btn').onclick = () => {
    if (!activeWorkflowId || nodes.length === 0) return;
    pushHistory();
    
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', marginx: 50, marginy: 50, nodesep: 60, ranksep: 100 });
    g.setDefaultEdgeLabel(() => ({}));
    
    nodes.forEach(n => g.setNode(n.id, { width: 140, height: 60 }));
    edges.forEach(e => g.setEdge(e.from, e.to));
    
    dagre.layout(g);
    
    g.nodes().forEach(v => {
        const node = nodes.find(n => n.id === v);
        if (node) {
            node.x = snapToGrid(g.node(v).x - 70);
            node.y = snapToGrid(g.node(v).y - 30);
        }
    });
    
    renderCanvas();
    broadcastUpdate();
};

// --- Minimap Engine ---
function updateMinimap() {
    if (!activeWorkflowId) {
        DOM.minimap.style.display = 'none';
        return;
    }
    
    DOM.minimap.style.display = 'block';
    DOM.minimapContent.innerHTML = '';

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(n => {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
    });

    minX -= 500; minY -= 500; maxX += 500; maxY += 500;
    const miniScale = Math.min(200 / (maxX - minX), 150 / (maxY - minY));

    nodes.forEach(n => {
        const el = document.createElement('div');
        el.className = 'minimap-node';
        el.style.left = ((n.x - minX) * miniScale) + 'px';
        el.style.top = ((n.y - minY) * miniScale) + 'px';
        el.style.width = (140 * miniScale) + 'px';
        el.style.height = (60 * miniScale) + 'px';
        if (selectedNodes.has(n.id)) el.style.background = 'var(--accent)';
        DOM.minimapContent.appendChild(el);
    });

    const canvasRect = DOM.canvas.getBoundingClientRect();
    DOM.minimapViewport.style.left = (((-transform.panX - minX) / transform.scale) * miniScale) + 'px';
    DOM.minimapViewport.style.top = (((-transform.panY - minY) / transform.scale) * miniScale) + 'px';
    DOM.minimapViewport.style.width = ((canvasRect.width / transform.scale) * miniScale) + 'px';
    DOM.minimapViewport.style.height = ((canvasRect.height / transform.scale) * miniScale) + 'px';
}

function snapToGrid(value) {
    return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

// --- Pan, Zoom & Marquee ---
DOM.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
        transform.scale = Math.min(Math.max(0.5, transform.scale * (e.deltaY > 0 ? 0.9 : 1.1)), 2);
        DOM.zoomLevel.textContent = `${Math.round(transform.scale * 100)}%`;
    } else {
        transform.panX -= e.deltaX;
        transform.panY -= e.deltaY;
    }
    applyTransform();
}, { passive: false });

DOM.canvas.addEventListener('mousedown', (e) => {
    if (e.target === DOM.canvas || e.target.id === 'svg-layer') {
        if (e.shiftKey) {
            dragState.isMarquee = true;
            dragState.startX = e.clientX;
            dragState.startY = e.clientY;
            DOM.marquee.style.display = 'block';
            DOM.marquee.style.left = (e.clientX - DOM.canvasContainer.getBoundingClientRect().left) / transform.scale + 'px';
            DOM.marquee.style.top = (e.clientY - DOM.canvasContainer.getBoundingClientRect().top) / transform.scale + 'px';
            DOM.marquee.style.width = '0px';
            DOM.marquee.style.height = '0px';
            if (!e.ctrlKey) {
                selectedNodes.clear();
                renderCanvas();
            }
        } else {
            isPanning = true;
            startPan = { x: e.clientX - transform.panX, y: e.clientY - transform.panY };
            selectedNodes.clear();
            renderCanvas();
        }
    }
});

window.addEventListener('mousemove', (e) => {
    if (isPanning) {
        transform.panX = e.clientX - startPan.x;
        transform.panY = e.clientY - startPan.y;
        applyTransform();
    }
    if (dragState.isMarquee) {
        const rect = DOM.canvasContainer.getBoundingClientRect();
        const left = Math.min(dragState.startX, e.clientX) - rect.left;
        const top = Math.min(dragState.startY, e.clientY) - rect.top;
        
        DOM.marquee.style.left = (left / transform.scale) + 'px';
        DOM.marquee.style.top = (top / transform.scale) + 'px';
        DOM.marquee.style.width = (Math.abs(e.clientX - dragState.startX) / transform.scale) + 'px';
        DOM.marquee.style.height = (Math.abs(e.clientY - dragState.startY) / transform.scale) + 'px';
    }
});

window.addEventListener('mouseup', () => {
    isPanning = false;
    if (dragState.isMarquee) {
        dragState.isMarquee = false;
        DOM.marquee.style.display = 'none';
        
        const mqLeft = parseFloat(DOM.marquee.style.left);
        const mqTop = parseFloat(DOM.marquee.style.top);
        const mqRight = mqLeft + parseFloat(DOM.marquee.style.width);
        const mqBottom = mqTop + parseFloat(DOM.marquee.style.height);
        
        nodes.forEach(n => {
            if ((n.x + 60) > mqLeft && (n.x + 60) < mqRight && (n.y + 30) > mqTop && (n.y + 30) < mqBottom) {
                selectedNodes.add(n.id);
            }
        });
        renderCanvas();
    }
});

document.getElementById('reset-view-btn').onclick = () => {
    transform = { scale: 1, panX: 0, panY: 0 };
    DOM.zoomLevel.textContent = `100%`;
    applyTransform();
};

function applyTransform() {
    DOM.canvasContainer.style.transform = `translate(${transform.panX}px, ${transform.panY}px) scale(${transform.scale})`;
    DOM.canvas.style.backgroundPosition = `${transform.panX}px ${transform.panY}px`;
    DOM.canvas.style.backgroundSize = `${GRID_SIZE * transform.scale}px ${GRID_SIZE * transform.scale}px`;
    updateMinimap();
}

// --- Custom Input Modal State ---
let pendingAction = null;

function openNameModal(title, label, actionData) {
    document.getElementById('name-input-title').innerText = title;
    document.getElementById('name-input-label').innerText = label;
    document.getElementById('name-input-field').value = '';
    pendingAction = actionData;
    document.getElementById('name-input-modal').classList.add('active');
    document.getElementById('name-input-field').focus();
}

document.getElementById('save-name-btn').onclick = () => {
    const name = document.getElementById('name-input-field').value.trim();
    if (!name) return;

    if (pendingAction.type === 'project') {
        workspaceData.projects.push({ id: Date.now().toString(), name, workflows: [] });
    } else if (pendingAction.type === 'workflow') {
        workspaceData.projects.find(p => p.id === pendingAction.parentId).workflows.push({ id: Date.now().toString(), name, nodes: [], edges: [] });
    }
    
    document.getElementById('name-input-modal').classList.remove('active');
    broadcastUpdate();
    renderSidebar();
};

document.getElementById('name-input-field').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('save-name-btn').click();
});

// --- IDE Sidebar Rendering ---
document.getElementById('add-project-btn').addEventListener('click', () => {
    openNameModal("New Project", "Project Name", { type: 'project' });
});

window.deleteProject = (e, projId) => {
    e.stopPropagation();
    if (confirm("Delete project?")) {
        workspaceData.projects = workspaceData.projects.filter(p => p.id !== projId);
        if (activeProjectId === projId) clearWorkspace();
        broadcastUpdate();
        renderSidebar();
    }
};

window.deleteWorkflow = (e, projId, wfId) => {
    e.stopPropagation();
    if (confirm("Delete workflow?")) {
        const proj = workspaceData.projects.find(p => p.id === projId);
        proj.workflows = proj.workflows.filter(w => w.id !== wfId);
        if (activeWorkflowId === wfId) clearWorkspace();
        broadcastUpdate();
        renderSidebar();
    }
};

function clearWorkspace() {
    activeProjectId = null;
    activeWorkflowId = null;
    nodes = [];
    edges = [];
    document.getElementById('current-path').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg> <span>Select a workflow...</span>`;
    DOM.toolbarTools.style.display = 'none';
    renderCanvas();
}

window.addWorkflow = (e, projId) => {
    e.stopPropagation();
    openNameModal("New Workflow", "Workflow Name", { type: 'workflow', parentId: projId });
};

function renderSidebar() {
    DOM.projectList.innerHTML = '';
    
    const folderIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
    const fileIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`;
    const trashIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
    const plusIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;

    workspaceData.projects.forEach(proj => {
        const pLi = document.createElement('li');
        pLi.className = 'project-item';
        pLi.innerHTML = `
            <div class="item-content">${folderIcon} <strong>${proj.name}</strong></div>
            <div class="action-icons">
                <span class="add-wf" title="Add Workflow" onclick="addWorkflow(event, '${proj.id}')">${plusIcon}</span>
                <span title="Delete Project" onclick="deleteProject(event, '${proj.id}')">${trashIcon}</span>
            </div>
        `;
        DOM.projectList.appendChild(pLi);
        
        const wfContainer = document.createElement('ul');
        wfContainer.className = 'workflow-list';
        
        proj.workflows.forEach(wf => {
            const wLi = document.createElement('li');
            wLi.className = `workflow-item ${wf.id === activeWorkflowId ? 'active' : ''}`;
            wLi.innerHTML = `
                <div class="item-content">${fileIcon} <span>${wf.name}</span></div>
                <div class="action-icons">
                    <span title="Delete Workflow" onclick="deleteWorkflow(event, '${proj.id}', '${wf.id}')">${trashIcon}</span>
                </div>
            `;
            wLi.onclick = () => loadWorkflow(proj.id, wf.id);
            wfContainer.appendChild(wLi);
        });
        
        DOM.projectList.appendChild(wfContainer);
    });
}

function loadWorkflow(projId, wfId) {
    if (activeWorkflowId) updateCurrentWorkflowState();
    
    activeProjectId = projId;
    activeWorkflowId = wfId;
    
    const proj = workspaceData.projects.find(p => p.id === projId);
    const wf = proj.workflows.find(w => w.id === wfId);
    
    document.getElementById('current-path').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg> <span>${proj.name} / ${wf.name}</span>`;
    DOM.toolbarTools.style.display = 'flex';
    
    nodes = JSON.parse(JSON.stringify(wf.nodes || []));
    edges = JSON.parse(JSON.stringify(wf.edges || []));
    
    selectedNodes.clear();
    historyStack = [];
    pushHistory();
    
    renderCanvas();
    renderSidebar();
}

// --- Drag, Drop & Render ---
document.querySelectorAll('.node-tool').forEach(tool => {
    tool.addEventListener('dragstart', (e) => e.dataTransfer.setData('type', tool.dataset.type));
});

DOM.canvas.addEventListener('dragover', (e) => e.preventDefault());
DOM.canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('type');
    if (!type || !activeWorkflowId) return;
    
    pushHistory();
    const rect = DOM.canvas.getBoundingClientRect();
    
    nodes.push({
        id: 'node_' + Date.now(),
        type,
        x: snapToGrid((e.clientX - rect.left - transform.panX) / transform.scale - 60),
        y: snapToGrid((e.clientY - rect.top - transform.panY) / transform.scale - 30),
        label: type.toUpperCase(),
        status: 'none',
        notes: '',
        url: '',
        user: '',
        pass: ''
    });
    
    renderCanvas();
    broadcastUpdate();
});

function renderCanvas() {
    Array.from(DOM.canvasContainer.children).forEach(child => {
        if (child.id !== 'svg-layer' && child.id !== 'marquee' && !child.classList.contains('node-tooltip')) {
            child.remove();
        }
    });
    
    nodes.forEach(node => {
        const el = document.createElement('div');
        el.className = `node node-${node.type} ${selectedNodes.has(node.id) ? 'selected' : ''}`;
        el.dataset.type = node.type;
        el.dataset.id = node.id;
        el.style.left = node.x + 'px';
        el.style.top = node.y + 'px';
        
        let statusHtml = node.status && node.status !== 'none' ? `<div class="node-status-badge status-${node.status}">${node.status}</div>` : '';
        el.innerHTML = `${statusHtml}<div class="icon">${NodeIcons[node.type]}</div><span class="label">${node.label}</span>`;
        
        // Tooltip Event
        el.addEventListener('mouseenter', () => {
            if (dragState.isDragging || connectionState.isConnecting) return;
            let html = '';
            if (node.notes) html += `<strong>Notes</strong><div class="val">${node.notes}</div>`;
            if (node.url) html += `<strong>URL</strong><div class="val">${node.url}</div>`;
            if (node.user) html += `<strong>User</strong><div class="val">${node.user}</div>`;
            if (html === '') html = `<div style="color: var(--text-muted); text-align: center;">No context. Dbl-click to edit.</div>`;
            
            tooltipEl.innerHTML = html;
            tooltipEl.classList.add('visible');
            tooltipEl.style.left = (node.x + 140) + 'px';
            tooltipEl.style.top = node.y + 'px';
        });
        
        el.addEventListener('mouseleave', () => tooltipEl.classList.remove('visible'));
        
        // Connectors Setup
        ['top', 'right', 'bottom', 'left'].forEach(pos => {
            const port = document.createElement('div');
            port.className = `connector ${pos}`;
            
            port.onmousedown = (e) => {
                e.stopPropagation();
                pushHistory();
                connectionState = { isConnecting: true, fromNode: node.id, fromPort: pos };
            };
            
            port.onmouseup = (e) => {
                e.stopPropagation();
                if (connectionState.isConnecting && connectionState.fromNode !== node.id) {
                    edges.push({
                        id: 'edge_' + Date.now(),
                        from: connectionState.fromNode,
                        fromPort: connectionState.fromPort,
                        to: node.id,
                        toPort: pos,
                        label: ''
                    });
                    renderCanvas();
                    broadcastUpdate();
                }
                connectionState.isConnecting = false;
            };
            el.appendChild(port);
        });
        
        // Node Click & Drag Selection Logic
        el.onmousedown = (e) => {
            if (e.target.classList.contains('connector')) return;
            
            if (!selectedNodes.has(node.id) && !e.ctrlKey) {
                selectedNodes.clear();
                selectedNodes.add(node.id);
                document.querySelectorAll('.node').forEach(n => n.classList.remove('selected'));
                el.classList.add('selected');
            } else if (e.ctrlKey) {
                if (selectedNodes.has(node.id)) {
                    selectedNodes.delete(node.id);
                    el.classList.remove('selected');
                } else {
                    selectedNodes.add(node.id);
                    el.classList.add('selected');
                }
            }
            
            const rect = DOM.canvas.getBoundingClientRect();
            dragState = {
                isDragging: true,
                hasMoved: false,
                prevX: (e.clientX - rect.left - transform.panX) / transform.scale,
                prevY: (e.clientY - rect.top - transform.panY) / transform.scale
            };
        };
        
        // Open Modal
        el.ondblclick = (e) => {
            e.stopPropagation();
            openModal(node.id);
        };
        
        DOM.canvasContainer.appendChild(el);
    });
    
    drawEdges();
    updateMinimap();
}

// --- Group Drag Handling ---
DOM.canvas.onmousemove = (e) => {
    if (dragState.isDragging) {
        if (!dragState.hasMoved) {
            pushHistory();
            dragState.hasMoved = true;
        }
        
        const rect = DOM.canvas.getBoundingClientRect();
        let curX = (e.clientX - rect.left - transform.panX) / transform.scale;
        let curY = (e.clientY - rect.top - transform.panY) / transform.scale;
        let dx = curX - dragState.prevX;
        let dy = curY - dragState.prevY;
        
        selectedNodes.forEach(id => {
            const node = nodes.find(n => n.id === id);
            node.x += dx;
            node.y += dy;
            const el = document.querySelector(`.node[data-id="${node.id}"]`);
            if (el) {
                el.style.left = snapToGrid(node.x) + 'px';
                el.style.top = snapToGrid(node.y) + 'px';
            }
        });
        
        dragState.prevX = curX;
        dragState.prevY = curY;
        drawEdges();
    }
    
    if (connectionState.isConnecting) drawEdges(e);
};

DOM.canvas.onmouseup = () => {
    if (dragState.isDragging && dragState.hasMoved) {
        selectedNodes.forEach(id => {
            const node = nodes.find(n => n.id === id);
            node.x = snapToGrid(node.x);
            node.y = snapToGrid(node.y);
        });
        renderCanvas();
        broadcastUpdate();
    }
    dragState.isDragging = false;
    if (connectionState.isConnecting) {
        connectionState.isConnecting = false;
        drawEdges();
    }
};

// --- Edge Drawing Engine ---
function drawEdges(tempEvent = null) {
    const defs = DOM.svgLayer.querySelector('defs');
    DOM.svgLayer.innerHTML = '';
    if (defs) DOM.svgLayer.appendChild(defs);
    
    edges.forEach(edge => {
        const fromEl = document.querySelector(`.node[data-id="${edge.from}"] .connector.${edge.fromPort}`);
        const toEl = document.querySelector(`.node[data-id="${edge.to}"] .connector.${edge.toPort}`);
        if (fromEl && toEl) drawAdvancedPath(getCenter(fromEl), getCenter(toEl), edge.fromPort, edge.toPort, edge.id);
    });
    
    if (tempEvent && connectionState.isConnecting) {
        const fromEl = document.querySelector(`.node[data-id="${connectionState.fromNode}"] .connector.${connectionState.fromPort}`);
        const rect = DOM.canvas.getBoundingClientRect();
        const mousePos = {
            x: (tempEvent.clientX - rect.left - transform.panX) / transform.scale,
            y: (tempEvent.clientY - rect.top - transform.panY) / transform.scale
        };
        drawAdvancedPath(getCenter(fromEl), mousePos, connectionState.fromPort, 'top', 'temp');
    }
}

function getCenter(el) {
    const rect = el.getBoundingClientRect();
    const cr = DOM.canvasContainer.getBoundingClientRect();
    return {
        x: (rect.left - cr.left + rect.width / 2) / transform.scale,
        y: (rect.top - cr.top + rect.height / 2) / transform.scale
    };
}

function drawAdvancedPath(p1, p2, port1, port2, edgeId) {
    const curve = 80;
    const cp1 = { x: p1.x, y: p1.y };
    const cp2 = { x: p2.x, y: p2.y };
    
    if (port1 === 'right') cp1.x += curve; else if (port1 === 'left') cp1.x -= curve; else if (port1 === 'top') cp1.y -= curve; else if (port1 === 'bottom') cp1.y += curve;
    if (port2 === 'right') cp2.x += curve; else if (port2 === 'left') cp2.x -= curve; else if (port2 === 'top') cp2.y -= curve; else if (port2 === 'bottom') cp2.y += curve;
    
    const pathString = `M ${p1.x} ${p1.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${p2.x} ${p2.y}`;
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'edge-group');
    
    const hitbox = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hitbox.setAttribute('d', pathString);
    hitbox.setAttribute('class', 'edge-hitbox');
    
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathString);
    path.setAttribute('class', 'edge-visible');
    
    if (edgeId !== 'temp') {
        path.setAttribute('marker-end', 'url(#arrowhead)');
        group.addEventListener('mouseenter', () => path.setAttribute('marker-end', 'url(#arrowhead-hover)'));
        group.addEventListener('mouseleave', () => path.setAttribute('marker-end', 'url(#arrowhead)'));
        
        group.ondblclick = (e) => {
            e.stopPropagation();
            openEdgeModal(edgeId);
        };
        
        const edgeData = edges.find(e => e.id === edgeId);
        if (edgeData && edgeData.label) {
            const midX = 0.125 * p1.x + 0.375 * cp1.x + 0.375 * cp2.x + 0.125 * p2.x;
            const midY = 0.125 * p1.y + 0.375 * cp1.y + 0.375 * cp2.y + 0.125 * p2.y;
            
            const textWidth = edgeData.label.length * 7 + 16;
            
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', midX - textWidth / 2);
            rect.setAttribute('y', midY - 10);
            rect.setAttribute('width', textWidth);
            rect.setAttribute('height', 20);
            rect.setAttribute('class', 'edge-label-rect');
            
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', midX);
            text.setAttribute('y', midY);
            text.setAttribute('class', 'edge-label-text');
            text.textContent = edgeData.label;
            
            group.appendChild(rect);
            group.appendChild(text);
        }
    }
    
    group.appendChild(hitbox);
    group.appendChild(path);
    DOM.svgLayer.appendChild(group);
}

// --- Modals, Delete Buttons & Export ---
let editingNodeId = null;
let editingEdgeId = null;

function openModal(nodeId) {
    editingNodeId = nodeId;
    const node = nodes.find(n => n.id === nodeId);
    document.getElementById('node-label').value = node.label || '';
    document.getElementById('node-status').value = node.status || 'none';
    document.getElementById('node-notes').value = node.notes || '';
    document.getElementById('node-url').value = node.url || '';
    document.getElementById('node-user').value = node.user || '';
    document.getElementById('node-pass').value = node.pass || '';
    document.getElementById('node-modal').classList.add('active');
}

function openEdgeModal(edgeId) {
    editingEdgeId = edgeId;
    const edge = edges.find(e => e.id === edgeId);
    document.getElementById('edge-label').value = edge.label || '';
    document.getElementById('edge-modal').classList.add('active');
}

document.querySelectorAll('.close-btn').forEach(btn => {
    btn.onclick = () => document.getElementById(btn.dataset.target).classList.remove('active');
});

document.getElementById('help-btn').onclick = () => document.getElementById('help-modal').classList.add('active');

document.getElementById('delete-node-btn').onclick = () => {
    if (confirm("Delete this node?")) {
        pushHistory();
        nodes = nodes.filter(n => n.id !== editingNodeId);
        edges = edges.filter(e => e.from !== editingNodeId && e.to !== editingNodeId);
        document.getElementById('node-modal').classList.remove('active');
        renderCanvas();
        broadcastUpdate();
    }
};

document.getElementById('save-node-btn').onclick = () => {
    pushHistory();
    const node = nodes.find(n => n.id === editingNodeId);
    node.label = document.getElementById('node-label').value;
    node.status = document.getElementById('node-status').value;
    node.notes = document.getElementById('node-notes').value;
    node.url = document.getElementById('node-url').value;
    node.user = document.getElementById('node-user').value;
    node.pass = document.getElementById('node-pass').value;
    
    document.getElementById('node-modal').classList.remove('active');
    renderCanvas();
    broadcastUpdate();
};

document.getElementById('delete-edge-btn').onclick = () => {
    if (confirm("Delete this connector?")) {
        pushHistory();
        edges = edges.filter(e => e.id !== editingEdgeId);
        document.getElementById('edge-modal').classList.remove('active');
        renderCanvas();
        broadcastUpdate();
    }
};

document.getElementById('save-edge-btn').onclick = () => {
    pushHistory();
    const edge = edges.find(e => e.id === editingEdgeId);
    edge.label = document.getElementById('edge-label').value;
    document.getElementById('edge-modal').classList.remove('active');
    renderCanvas();
    broadcastUpdate();
};

// Image Export
document.getElementById('export-trigger-btn').addEventListener('click', () => {
    if (!activeWorkflowId) return alert("Please open a workflow to export.");
    document.getElementById('export-modal').classList.add('active');
});

document.getElementById('confirm-export-btn').addEventListener('click', async () => {
    const format = document.getElementById('export-format').value;
    document.getElementById('export-modal').classList.remove('active');
    
    const btn = document.getElementById('export-trigger-btn');
    btn.textContent = "Rendering...";
    
    const oldTransform = { ...transform };
    transform = { scale: 1, panX: 0, panY: 0 };
    applyTransform();
    
    const originalBg = DOM.canvasContainer.style.backgroundColor;
    if (format === 'jpeg') {
        const theme = document.documentElement.getAttribute('data-theme');
        DOM.canvasContainer.style.backgroundColor = theme === 'light' ? '#f0f4f8' : (theme === 'ocean' ? '#0f172a' : '#090a0c');
    } else {
        DOM.canvasContainer.style.backgroundColor = 'transparent';
    }
    
    await new Promise(r => setTimeout(r, 200));
    
    const canvasObj = await html2canvas(DOM.canvasContainer, {
        backgroundColor: format === 'jpeg' ? DOM.canvasContainer.style.backgroundColor : null,
        logging: false
    });
    
    const link = document.createElement('a');
    link.download = `flowforge-export-${Date.now()}.${format}`;
    link.href = canvasObj.toDataURL(`image/${format}`, 1.0);
    link.click();
    
    DOM.canvasContainer.style.backgroundColor = originalBg;
    transform = oldTransform;
    applyTransform();
    btn.textContent = "Export";
});

document.getElementById('save-btn').addEventListener('click', () => {
    broadcastUpdate();
    const btn = document.getElementById('save-btn');
    btn.textContent = "Saved!";
    setTimeout(() => btn.textContent = "Force Save", 2000);
});

// --- Mobile Responsiveness Logic ---
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const sidebarEl = document.querySelector('.sidebar');

if (mobileMenuBtn && sidebarEl) {
    mobileMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sidebarEl.classList.toggle('open');
    });

    DOM.canvas.addEventListener('mousedown', () => {
        if (window.innerWidth <= 768 && sidebarEl.classList.contains('open')) {
            sidebarEl.classList.remove('open');
        }
    });

    const originalLoadWorkflow = loadWorkflow;
    window.loadWorkflow = function(projId, wfId) {
        originalLoadWorkflow(projId, wfId);
        if (window.innerWidth <= 768) {
            sidebarEl.classList.remove('open');
        }
    };
}

// Start Application
loadData();