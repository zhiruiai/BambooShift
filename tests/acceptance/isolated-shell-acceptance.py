#!/usr/bin/env python3
"""Explicit deployment acceptance, run inside the dedicated VM (never health).

Uses only synthetic files in a unique workspace subdirectory and removes them.
Emits non-secret evidence JSON. Does not connect, resume, or renew a VM.
"""
import hashlib
import json
import os
import pathlib
import shlex
import shutil
import signal
import subprocess
import sys
import time
import uuid

SCRIPT = '/opt/openbot/isolated-shell.py'
CONTROL = pathlib.Path('/opt/openbot/shell')
WORKSPACE = pathlib.Path('/opt/openbot/workspace')
CONFIG = json.loads((CONTROL / 'config.json').read_text())
CGROUP = pathlib.Path(CONFIG['cgroupRoot'])
ENV = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
       'OPENBOT_ACCEPTANCE_FAKE_SECRET': 'synthetic-must-not-be-inherited'}
PREFIX = '.openbot-shell-check-' + uuid.uuid4().hex
EVIDENCE = {'schemaVersion': 1, 'scope': 'explicit-current-workspace',
            'component': 'isolated-shell-v1', 'checks': {}}


def invoke(mode, payload=None):
    p = subprocess.run([sys.executable, SCRIPT, mode], input=json.dumps(payload) if payload else '',
                       capture_output=True, text=True, env=ENV, timeout=40)
    result = json.loads(p.stdout)
    assert p.returncode == 0 and not result.get('error'), (mode, p.returncode, result)
    return result


def run(command, **options):
    return invoke('--run', {'version': 1, 'command': command, 'cwd': options.get('cwd', '.'),
                            'timeoutMs': options.get('timeoutMs', 30000)})


def python(source):
    return 'python3 -c ' + shlex.quote(source)


def child_groups():
    return [p for p in CGROUP.iterdir() if p.is_dir()]


def wait_job():
    until = time.monotonic() + 5
    while time.monotonic() < until:
        groups = child_groups()
        if groups:
            try:
                if len((groups[0] / 'cgroup.procs').read_text().split()) >= 2:
                    time.sleep(0.15)
                    return groups[0]
            except FileNotFoundError:
                pass
        time.sleep(0.03)
    raise AssertionError('task did not enter its cgroup')


def wait_clean(group):
    until = time.monotonic() + 5
    while time.monotonic() < until:
        if not group.exists() or 'populated 1' not in (group / 'cgroup.events').read_text():
            return
        time.sleep(0.05)
    raise AssertionError('task descendants remain alive')


def start(command):
    p = subprocess.Popen([sys.executable, SCRIPT, '--run'], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=ENV)
    p.stdin.write(json.dumps({'version': 1, 'command': command, 'cwd': '.', 'timeoutMs': 30000}))
    p.stdin.close()
    return p


def detached_command():
    child = "import os,signal,time;os.setsid();signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(25)"
    return python("import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',%r]);print('started',flush=True);time.sleep(25)" % child)


def main():
    initial_probe = invoke('--probe')
    assert initial_probe['available']
    worker_pid = int(pathlib.Path('/opt/openbot/worker.pid').read_text())
    worker_start = pathlib.Path('/proc/%d/stat' % worker_pid).read_text().rsplit(')', 1)[1].split()[19]
    original = json.loads((CONTROL / 'workspace-before.json').read_text())
    try:
        result = run(python("import os,json,pathlib; p=pathlib.Path(%r);p.mkdir();text='你好，真实远程代码执行。';(p/'report.txt').write_text(text+' 17 × 23 = '+str(17*23));print(json.dumps({'uid':os.getuid(),'value':17*23,'text':text},ensure_ascii=False))" % PREFIX))
        report = json.loads(result['stdout'])
        assert report == {'uid': 65532, 'value': 391, 'text': '你好，真实远程代码执行。'}
        EVIDENCE['checks']['pythonChineseReport'] = {'passed': True, 'uid': report['uid'], 'value': report['value']}
        result = run("node -e \"console.log(17*23)\"")
        assert result['exitCode'] == 0 and result['stdout'].strip() == '391'
        EVIDENCE['checks']['node'] = True
        # Make a simulated Worker upload: root-owned 0600. Preparation must preserve bytes.
        upload = WORKSPACE / PREFIX / 'new-upload.txt'
        upload.write_text('synthetic upload')
        upload.chmod(0o600)
        result = run('cat ' + shlex.quote(PREFIX + '/new-upload.txt'))
        assert result['stdout'] == 'synthetic upload' and upload.stat().st_uid == 65532
        EVIDENCE['checks']['newRootOwnedUpload'] = True
        result = run(python("import os,pathlib,socket;assert 'OPENBOT_ACCEPTANCE_FAKE_SECRET' not in os.environ;assert not pathlib.Path('/opt/openbot/worker-token').exists();assert not pathlib.Path('/opt/openbot/browser-profile').exists();assert not pathlib.Path('/sys/fs/cgroup').exists();s=pathlib.Path('/proc/self/status').read_text();assert 'CapEff:\\t0000000000000000' in s;assert 'NoNewPrivs:\\t1' in s;assert os.statvfs('/usr/bin').f_flag & os.ST_RDONLY\nfor address,port in [('127.0.0.1',9),('127.0.0.1',80),('192.0.2.1',443),('198.51.100.1',53)]:\n sock=socket.socket();sock.settimeout(.2)\n try:\n  sock.connect((address,port));raise AssertionError('network reachable')\n except OSError:pass\n finally:sock.close()\nprint('isolated')"))
        assert result['exitCode'] == 0 and result['stdout'].strip() == 'isolated', result
        EVIDENCE['checks']['controlEnvironmentNetworkAndReadonlyRoot'] = True
        result = run('python3 -m venv --without-pip ' + shlex.quote(PREFIX + '/venv'))
        assert result['exitCode'] == 0, result
        result = run(python("import os,pathlib;p=pathlib.Path(%r);os.symlink('report.txt',p/'link');os.link(p/'report.txt',p/'hardlink');print('links made')" % PREFIX))
        assert result['exitCode'] == 0
        result = run('./venv/bin/python -c "print(391)"', cwd=PREFIX)
        assert result['stdout'].strip() == '391', result
        EVIDENCE['checks']['venvSymlinksAndHardlinksSurviveNextRun'] = True
        result = run(python("import os,time;raw='中文连续输出'.encode();[os.write(1,raw[i:i+1]) for i in range(len(raw))]"))
        assert result['stdout'] == '中文连续输出', result
        result = run(python("import os;os.write(1,('中文'*100000).encode());os.write(2,b'x'*100000)"))
        assert result['truncated'] and len((result['stdout'] + result['stderr']).encode()) <= 262144
        assert '\ufffd' not in result['stdout']
        EVIDENCE['checks']['utf8AndBoundedCombinedOutput'] = True
        result = run('exit 7')
        assert result['exitCode'] == 7 and invoke('--probe')['available']
        EVIDENCE['checks']['nonzeroIsNormalResult'] = True
        result = run('kill -35 $$')
        assert result['signal'] == 'SIG35' and result['exitCode'] is None, result
        EVIDENCE['checks']['unnamedRealtimeSignalIsNormalResult'] = True
        command = 'printf ok\n#'
        command += '中' * (16000 - len(command))
        result = run(command)
        assert result['stdout'] == 'ok' and result['exitCode'] == 0, result
        result = run(command, cwd='中' * 4096)
        assert result['exitCode'] == 2 and invoke('--probe')['available'], result
        EVIDENCE['checks']['maximumUnicodeCommandAndCwdEnvelope'] = True
        result = run(python("import os,time,errno;count=0;blocked=False\nfor i in range(80):\n try:pid=os.fork()\n except OSError as e:blocked=e.errno==errno.EAGAIN;break\n if pid==0:time.sleep(20);os._exit(0)\n count+=1\nprint(count,blocked,flush=True)"))
        assert result['exitCode'] == 0 and result['stdout'].strip().endswith('True') and result.get('resourceLimit') == 'pids', result
        assert not child_groups()
        EVIDENCE['checks']['pidsLimitAndNormalExitCleansBackground'] = True
        result = run(detached_command(), timeoutMs=1000)
        assert result['timedOut'] and not child_groups(), result
        EVIDENCE['checks']['deadlineKillsSetsidAndTermIgnoringDescendants'] = True
        p = start(detached_command())
        group = wait_job()
        p.terminate()
        p.wait(timeout=8)
        result = json.loads(p.stdout.read())
        assert result['cancelled'] and p.returncode == 0, result
        wait_clean(group)
        EVIDENCE['checks']['sigtermCancellation'] = True
        injection = "import importlib.util,os,signal,sys;s=importlib.util.spec_from_file_location('isolated',%r);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);original=m.prepare_workspace\ndef prepare(*args):\n os.kill(os.getpid(),signal.SIGTERM)\n return original(*args)\nm.prepare_workspace=prepare;sys.argv=[%r,'--run'];sys.exit(m.main())" % (SCRIPT, SCRIPT)
        p = subprocess.run([sys.executable,'-c',injection], input=json.dumps({'version':1,'command':'exit 0'}),capture_output=True,text=True,env=ENV,timeout=10)
        result = json.loads(p.stdout)
        assert p.returncode == 0 and result['cancelled'] and not child_groups(), result
        EVIDENCE['checks']['startupSigtermFaultInjectionReturnsCancelled'] = True
        result = run(python('x=bytearray(650*1024*1024);print(len(x))'))
        assert result.get('resourceLimit') == 'memory' and result['signal'] == 'SIGKILL', result
        assert invoke('--probe')['available'] and not child_groups()
        EVIDENCE['checks']['oomIsResourceResultAndWorkerSurvives'] = True
        p = start(detached_command())
        group = wait_job()
        p.kill()
        p.wait(timeout=5)
        wait_clean(group)
        state = invoke('--probe')
        assert not state['available'] and state['reason'] == 'RECOVERY_REQUIRED', state
        assert invoke('--recover')['available'] and not child_groups()
        EVIDENCE['checks']['supervisorSigkillCleansDescendantsAndRequiresExplicitRecovery'] = True
        payload = json.dumps({'version': 1, 'command': detached_command(), 'cwd': '.', 'timeoutMs': 30000})
        wrapper = "import subprocess,sys,time;p=subprocess.Popen([sys.executable,%r,'--run'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);p.stdin.write(%r);p.stdin.close();print(p.pid,flush=True);time.sleep(25)" % (SCRIPT, payload.encode())
        parent = subprocess.Popen([sys.executable, '-c', wrapper], stdout=subprocess.PIPE, text=True, env=ENV)
        supervisor = int(parent.stdout.readline())
        group = wait_job()
        parent.kill()
        parent.wait(timeout=5)
        wait_clean(group)
        deadline = time.monotonic() + 5
        while list((CONTROL / 'jobs').iterdir()) and time.monotonic() < deadline:
            time.sleep(.05)
        assert not child_groups() and not list((CONTROL / 'jobs').iterdir())
        assert invoke('--probe')['available']
        EVIDENCE['checks']['workerParentDeathCancelsAndCleans'] = True
        # Bounded allocation: always leave >= approximately 88 MiB. Never fill the disk.
        free = shutil.disk_usage(WORKSPACE).free
        allocation = free - 96 * 1024 * 1024 + 8 * 1024 * 1024
        assert 0 < allocation < 220 * 1024 * 1024
        code = "import os,pathlib,time;remaining=%d;i=0;p=pathlib.Path(%r)\nwhile remaining:\n size=min(48*1024*1024,remaining);fd=os.open(p/('guard.'+str(i)),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\n try:os.posix_fallocate(fd,0,size)\n finally:os.close(fd)\n remaining-=size;i+=1\ntime.sleep(5)" % (allocation, PREFIX)
        result = run(python(code))
        lowest_free = shutil.disk_usage(WORKSPACE).free
        assert result.get('resourceLimit') == 'disk-reserve' and lowest_free >= 80*1024*1024, result
        for item in (WORKSPACE / PREFIX).glob('guard.*'):
            item.unlink()
        EVIDENCE['checks']['diskLowWaterGuard'] = {'passed': True, 'lowestObservedFreeBytes': lowest_free,
                                                  'boundedAllocationBytes': allocation, 'testFilesRemoved': True}
        assert pathlib.Path('/proc/%d/stat' % worker_pid).read_text().rsplit(')', 1)[1].split()[19] == worker_start
        EVIDENCE['checks']['originalWorkerProcessUnchanged'] = True
        preserved = 0
        for relative, record in original.items():
            if 'sha256' in record:
                assert hashlib.sha256((WORKSPACE / relative).read_bytes()).hexdigest() == record['sha256']
                preserved += 1
        EVIDENCE['checks']['existingWorkspaceBytesPreserved'] = {'passed': True, 'files': preserved}
    finally:
        fixture = WORKSPACE / PREFIX
        if fixture.exists():
            shutil.rmtree(fixture)
    EVIDENCE.update({'verifiedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                     'scriptSha256': hashlib.sha256(pathlib.Path(SCRIPT).read_bytes()).hexdigest(),
                     'remainingBytes': shutil.disk_usage(WORKSPACE).free,
                     'leftoverJobDirectories': len(list((CONTROL / 'jobs').iterdir())),
                     'leftoverCgroups': len(child_groups()),
                     'fixturesRemoved': not (WORKSPACE / PREFIX).exists(),
                     'limits': initial_probe['limits']})
    print(json.dumps(EVIDENCE, ensure_ascii=False))


if __name__ == '__main__':
    main()
