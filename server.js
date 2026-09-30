const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');

function loadState() {
    if (!fs.existsSync(DATA_FILE)) return { students: [], companies: [] };
    try {
        const state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        return {
            students: Array.isArray(state.students) ? state.students : [],
            companies: Array.isArray(state.companies) ? state.companies : []
        };
    } catch {
        throw new Error('data.json is invalid JSON');
    }
}

let state = loadState();

function saveState() {
    const temporaryFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryFile, DATA_FILE);
}

function sendJson(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.on('data', chunk => {
            body += chunk;
            if (body.length > 1_000_000) {
                reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
                request.destroy();
            }
        });
        request.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(Object.assign(new Error('Request body must be valid JSON'), { status: 400 }));
            }
        });
        request.on('error', reject);
    });
}

function validateId(value) {
    return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validateCgpa(value) {
    const cgpa = Number(value);
    return Number.isFinite(cgpa) && cgpa >= 0 && cgpa <= 10;
}

async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const method = request.method;
    const route = url.pathname;

    if (method === 'GET' && (route === '/' || route === '/index.html')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(fs.readFileSync(INDEX_FILE));
        return;
    }

    if (method === 'GET' && route === '/api/state') {
        sendJson(response, 200, state);
        return;
    }

    if (method === 'POST' && route === '/api/students') {
        const body = await readBody(request);
        if (!validateId(body.id) || !String(body.name || '').trim() || !validateCgpa(body.cgpa) || !String(body.branch || '').trim()) {
            sendJson(response, 400, { error: 'Provide a positive student ID, name, CGPA from 0 to 10, and branch.' });
            return;
        }
        const id = Number(body.id);
        if (state.students.some(student => student.id === id)) {
            sendJson(response, 409, { error: 'Student ID already exists.' });
            return;
        }
        const student = {
            id,
            name: String(body.name).trim(),
            cgpa: Number(body.cgpa),
            branch: String(body.branch).trim().toUpperCase(),
            isPlaced: false,
            appliedCompanyIds: []
        };
        state.students.push(student);
        saveState();
        sendJson(response, 201, student);
        return;
    }

    if (method === 'POST' && route === '/api/companies') {
        const body = await readBody(request);
        const branches = Array.isArray(body.eligibleBranches)
            ? body.eligibleBranches
            : String(body.eligibleBranches || '').split(',');
        const eligibleBranches = [...new Set(branches.map(branch => String(branch).trim().toUpperCase()).filter(Boolean))];
        if (!validateId(body.id) || !String(body.name || '').trim() || !validateCgpa(body.minCgpa) || eligibleBranches.length === 0) {
            sendJson(response, 400, { error: 'Provide a positive company ID, name, minimum CGPA from 0 to 10, and eligible branches.' });
            return;
        }
        const id = Number(body.id);
        if (state.companies.some(company => company.id === id)) {
            sendJson(response, 409, { error: 'Company ID already exists.' });
            return;
        }
        const company = { id, name: String(body.name).trim(), minCgpa: Number(body.minCgpa), eligibleBranches };
        state.companies.push(company);
        saveState();
        sendJson(response, 201, company);
        return;
    }

    const applicationMatch = route.match(/^\/api\/students\/(\d+)\/applications$/);
    if (method === 'POST' && applicationMatch) {
        const studentId = Number(applicationMatch[1]);
        const body = await readBody(request);
        if (!validateId(body.companyId)) {
            sendJson(response, 400, { error: 'Provide a valid company ID.' });
            return;
        }
        const student = state.students.find(item => item.id === studentId);
        const company = state.companies.find(item => item.id === Number(body.companyId));
        if (!student || !company) {
            sendJson(response, 404, { error: 'Student or company was not found.' });
            return;
        }
        if (student.isPlaced) {
            sendJson(response, 409, { error: 'Student is already placed.' });
            return;
        }
        if (student.cgpa < company.minCgpa || !company.eligibleBranches.includes(student.branch)) {
            sendJson(response, 403, { error: 'Student is not eligible for this company.' });
            return;
        }
        if (student.appliedCompanyIds.includes(company.id)) {
            sendJson(response, 409, { error: 'Student already applied to this company.' });
            return;
        }
        student.appliedCompanyIds.push(company.id);
        saveState();
        sendJson(response, 201, { studentId, companyId: company.id });
        return;
    }

    const placementMatch = route.match(/^\/api\/students\/(\d+)\/placement$/);
    if (method === 'PATCH' && placementMatch) {
        const body = await readBody(request);
        if (typeof body.isPlaced !== 'boolean') {
            sendJson(response, 400, { error: 'isPlaced must be a boolean.' });
            return;
        }
        const student = state.students.find(item => item.id === Number(placementMatch[1]));
        if (!student) {
            sendJson(response, 404, { error: 'Student was not found.' });
            return;
        }
        student.isPlaced = body.isPlaced;
        saveState();
        sendJson(response, 200, student);
        return;
    }

    sendJson(response, 404, { error: 'Route not found.' });
}

const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
        if (!response.headersSent) {
            sendJson(response, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
        }
    });
});

server.listen(PORT, () => console.log(`Placement Portal running at http://localhost:${PORT}`));