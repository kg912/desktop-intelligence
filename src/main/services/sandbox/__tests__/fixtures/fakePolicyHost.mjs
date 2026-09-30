// Protocol-compatible stand-in for policyHost.ts — no real sandbox. The
// wrapped command is prefixed with env assignments exposing which host
// (pid + policy) wrapped it and the per-wrap config it received, so tests can
// assert on routing without sandbox-exec.
let config = null

process.on('message', (msg) => {
  if (msg.t === 'init') {
    if (msg.config.network.allowedDomains.includes('fail-init.test')) {
      process.send({ t: 'init-error', message: 'simulated init failure' })
      return
    }
    config = msg.config
    process.send({ t: 'ready' })
  } else if (msg.t === 'wrap') {
    if (msg.command.startsWith('echo violate')) {
      process.send({
        t: 'violation',
        line: 'python3(4242) deny(1) file-read-data /Users/someone/.ssh/id_rsa',
        command: msg.command,
        timestamp: 1234,
      })
      process.send({ t: 'violation', line: 'python3(4242) deny(1) mach-lookup com.apple.x', command: msg.command, timestamp: 1235 })
    }
    const policy = JSON.stringify(config.network.allowedDomains)
    const wrapConfig = Buffer.from(JSON.stringify(msg.customConfig)).toString('base64')
    process.send({
      t: 'wrapped',
      id: msg.id,
      command: `export HOST_PID=${process.pid} HOST_POLICY='${policy}' WRAP_CONFIG=${wrapConfig}; ${msg.command}`,
    })
  } else if (msg.t === 'shutdown') {
    process.exit(0)
  }
})

process.on('disconnect', () => process.exit(0))
