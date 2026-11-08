import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createComputerWorkerPool } from '../../../../scripts/computer-worker.js';
import type {
  ScreenLifecycleReceipt,
  ScreenLifecycleRequest,
} from '../../../../shared/computer-screen-lifecycle.js';
import type { ComputerScreenPoolConfiguration } from '../../../../shared/computer-screens.js';
import type { BrowserScreenSession } from '../browser-engine.js';
import { ScreenLifecycleStore } from '../computer-screen-lifecycle.js';
import type { DesktopAdapter } from '../desktop.js';
import { createLinuxDesktopAdapter } from '../linux-desktop.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  pendingPhase?: 'reserved' | 'browser_closed' | 'desktop_ready',
  actualHungHelper = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'openbot-screen-lifecycle-'));
  const configuration: ComputerScreenPoolConfiguration = {
    version: 1,
    workspaceScopeId: randomUUID(),
    screens: [0, 1].map(() => {
      const id = randomUUID();
      return {
        id: randomUUID(),
        manifestPath: `/opt/openbot/desktop/sessions/${id}/manifest.json`,
        session: { id, generation: randomUUID() },
      };
    }),
  };
  const stateDir = join(root, 'lifecycle');
  const events: string[] = [],
    sessions = new Map(
      configuration.screens.map((screen) => [screen.session.id, screen.session.generation]),
    );
  let pending: ScreenLifecycleReceipt | undefined;
  if (pendingPhase) {
    const store = new ScreenLifecycleStore(
      stateDir,
      configuration.workspaceScopeId,
      configuration.screens,
    );
    const previous = store.snapshot(configuration.screens[0].id);
    pending = store.reserve(previous.screenId, {
      operationId: randomUUID(),
      kind: 'release',
      expectedRevision: previous.revision,
      expectedSession: previous.session,
    });
    pending.phase = pendingPhase;
    store.update(pending);
    if (pendingPhase === 'desktop_ready') {
      sessions.delete(pending.previous.session.id);
      sessions.set(pending.next.session.id, pending.next.session.generation);
    }
  }
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#998877' } })
    .png()
    .toBuffer();
  const helperPath = join(root, 'controlled-helper.mjs');
  const startedPath = join(root, 'helper-started'),
    releasePath = join(root, 'helper-release');
  const actualAdapters: DesktopAdapter[] = [];
  if (actualHungHelper)
    await writeFile(
      helperPath,
      `
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>raw+=x);
process.stdin.on('end',()=>{
 const request=JSON.parse(raw),config=JSON.parse(readFileSync(process.argv[3],'utf8'));
 const send=(value,code=0)=>process.stdout.write(JSON.stringify(value),()=>process.exit(code));
 const session=config.session;
 if(request.op==='status')return send({ok:true,result:{kind:'virtual',available:true,authorized:true,session,width:40,height:30,displayId:1,
 displays:[{id:1,x:0,y:0,logicalWidth:40,logicalHeight:30,pixelWidth:40,pixelHeight:30}],permissions:{screenRecording:'granted',accessibility:'granted'}}});
 if(request.op==='capture')return send({ok:true,result:{session,png:${JSON.stringify(png.toString('base64'))},width:40,height:30,displayId:1,geometryToken:'fixture',capturedAt:new Date().toISOString()}});
 if(config.hold){
  process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(startedPath)},String(process.pid));
  setInterval(()=>{if(existsSync(${JSON.stringify(releasePath)}))send({ok:false,error:{code:'CANCELLED',cleanupConfirmed:true}},2)},10);return;
 }
 send({ok:true,result:{ok:true,session,geometryToken:'fixture'}});
});
`,
    );
  const controls = {
    input: undefined as undefined | (() => Promise<void>),
    inputSignal: undefined as AbortSignal | undefined,
    inputs: 0,
    closeFails: false,
    driverFails: false,
    captureUnknown: false,
    driverWait: undefined as Promise<void> | undefined,
    driverCalls: 0,
    starts: 0,
    afterDriver: undefined as undefined | (() => Promise<void>),
  };
  const browsers = new Map<
    string,
    { open: boolean; closes: number; session: BrowserScreenSession }
  >();
  const token = 'synthetic-screen-lifecycle-token-12345';
  let worker!: ReturnType<typeof createComputerWorkerPool>,
    server: ReturnType<ReturnType<typeof createComputerWorkerPool>['app']['listen']>,
    base = '',
    instanceId = '';
  const start = async () => {
    worker = createComputerWorkerPool({
      token,
      workspaceDir: join(root, 'workspace'),
      configuration,
      interpreterPath: '/unused/python',
      helperPath: '/unused/helper',
      lifecycle: {
        stateDir,
        interpreterPath: '/unused/python',
        helperPath: '/unused/desktop-session.py',
      },
      browserSessionFor(id) {
        let state = browsers.get(id);
        if (!state) {
          state = { open: true, closes: 0, session: undefined! };
          const current = state;
          current.session = {
            peek: () => undefined,
            async open() {
              events.push('browser-open:' + id);
              current.open = true;
              return {} as never;
            },
            async close() {
              events.push('browser-close:' + id);
              current.closes++;
              if (controls.closeFails && id.startsWith(configuration.screens[0].id + ':'))
                throw new Error('synthetic close failure');
              current.open = false;
            },
          };
          browsers.set(id, current);
        }
        return state.session;
      },
      async lifecycleDriver(receipt) {
        events.push('driver:' + receipt.operationId);
        controls.driverCalls++;
        await controls.driverWait;
        if (controls.driverFails) throw new Error('synthetic unconfirmed supervisor exit');
        if (sessions.get(receipt.next.session.id) !== receipt.next.session.generation)
          controls.starts++;
        sessions.delete(receipt.previous.session.id);
        sessions.set(receipt.next.session.id, receipt.next.session.generation);
        await controls.afterDriver?.();
      },
      desktopAdapterFor(screen) {
        if (actualHungHelper && screen.id === configuration.screens[0].id) {
          const manifestPath = join(root, screen.session.generation + '.json');
          writeFileSync(
            manifestPath,
            JSON.stringify({
              session: screen.session,
              hold: screen.session.generation === configuration.screens[0].session.generation,
            }),
            { mode: 0o600 },
          );
          const adapter = createLinuxDesktopAdapter({
            interpreterPath: process.execPath,
            helperPath,
            manifestPath,
            platform: 'linux',
            timeoutMs: 5000,
            cleanupWaitMs: 50,
          });
          actualAdapters.push(adapter);
          return adapter;
        }
        let enabled = false;
        const adapter: DesktopAdapter = {
          async status() {
            return {
              kind: 'virtual',
              session: screen.session,
              available: sessions.get(screen.session.id) === screen.session.generation,
              authorized: true,
              enabled,
              width: 40,
              height: 30,
              displays: [],
              permissions: { screenRecording: 'granted', accessibility: 'granted' },
            };
          },
          setEnabled(value) {
            enabled = value;
          },
          async capture() {
            if (controls.captureUnknown && screen.id === configuration.screens[0].id)
              throw Object.assign(new Error('unknown synthetic capture'), {
                cleanupConfirmed: false,
              });
            return { png, width: 40, height: 30, capturedAt: new Date().toISOString() };
          },
          async execute(_input, options) {
            controls.inputs++;
            controls.inputSignal = options?.signal;
            await controls.input?.();
            return { ok: true };
          },
          async close() {
            enabled = false;
          },
        };
        return adapter;
      },
    });
    server = worker.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    instanceId = (await worker.health()).instanceId;
  };
  await start();
  const inventory = () => worker.inventory();
  const headers = (index: number, revision?: string) => ({
    Authorization: 'Bearer ' + token,
    'X-OpenBot-Worker-Instance': instanceId,
    'X-OpenBot-Control-Origin': 'none',
    'X-OpenBot-Workspace-Scope': configuration.workspaceScopeId,
    'X-OpenBot-Screen-Id': configuration.screens[index].id,
    ...(revision ? { 'X-OpenBot-Screen-Revision': revision } : {}),
  });
  const call = async (
    index: number,
    path: string,
    body?: unknown,
    revision?: string,
    session?: { id: string; generation: string },
    signal?: AbortSignal,
  ) => {
    const response = await fetch(base + '/screens/' + configuration.screens[index].id + path, {
      method: body === undefined ? 'GET' : 'POST',
      signal,
      headers: {
        ...headers(index, revision),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(session
          ? {
              'X-OpenBot-Desktop-Session': session.id,
              'X-OpenBot-Desktop-Generation': session.generation,
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    return { status: response.status, json };
  };
  const request = async (
    kind: 'release' | 'reset' = 'release',
  ): Promise<ScreenLifecycleRequest> => {
    const screen = (await inventory()).screens[0];
    return {
      operationId: randomUUID(),
      kind,
      expectedRevision: screen.revision!,
      expectedSession: screen.session,
    };
  };
  const stop = async () => {
    await worker.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
  return {
    root,
    stateDir,
    configuration,
    pending,
    controls,
    browsers,
    events,
    actualAdapters,
    startedPath,
    releasePath,
    inventory,
    call,
    request,
    async restart() {
      await stop();
      browsers.clear();
      await start();
    },
    async close() {
      controls.closeFails = false;
      if (actualHungHelper) await writeFile(releasePath, 'release');
      await stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export { deferred, fixture };
