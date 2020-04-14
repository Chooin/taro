import * as path from 'path'
import { EventEmitter } from 'events'

import { AsyncSeriesWaterfallHook } from 'tapable'
import { IProjectConfig, PluginItem } from '@tarojs/taro/types/compile'

import {
  IPreset,
  IPlugin,
  IPaths,
  IHook,
  ICommand,
  IPlatform
} from './utils/types'
import {
  PluginType,
} from './utils/constants'
import { mergePlugins, resolvePresetsOrPlugins, convertPluginsToObject } from './utils'
import createBabelRegister from './utils/babelRegister'
import Plugin from './Plugin'
import Config from './Config'

interface IKernelOptions {
  appPath: string
  isWatch: boolean
  isProduction: boolean
  presets: PluginItem[]
  plugins: PluginItem[]
}

export default class Kernel extends EventEmitter {
  appPath: string
  isWatch: boolean
  isProduction: boolean
  optsPresets: PluginItem[]
  optsPlugins: PluginItem[]
  plugins: Map<string, IPlugin>
  paths: IPaths
  extraPlugins: IPlugin[]
  config: Config
  initialConfig: IProjectConfig
  hooks: Map<string, IHook[]>
  methods: Map<string, Function>
  commands: Map<string, ICommand>
  platforms: Map<string, IPlatform>

  constructor (options: IKernelOptions) {
    super()
    this.appPath = options.appPath || process.cwd()
    this.isProduction = options.isProduction
    this.isWatch = options.isWatch
    this.optsPresets = options.presets
    this.optsPlugins = options.plugins
    this.hooks = new Map()
    this.methods = new Map()
    this.commands = new Map()
    this.platforms = new Map()
  }

  async init () {
    await this.initConfig()
    await this.initPaths()
    this.initPresetsAndPlugins()
    await this.applyPlugins('onReady')
  }

  async initConfig () {
    this.config = new Config({
      appPath: this.appPath,
      isWatch: this.isWatch,
      isProduction: this.isProduction
    })
    this.initialConfig = await this.applyPlugins({
      name: 'modifyConfig',
      initialVal: this.config.initialConfig
    })
  }

  async initPaths () {
    this.paths = await this.applyPlugins({
      name: 'modifyPaths',
      initialVal: {
        appPath: this.appPath,
        configPath: this.config.configPath,
        sourcePath: path.join(this.appPath, this.initialConfig.sourceRoot as string),
        outputPath: path.join(this.appPath, this.initialConfig.outputRoot as string)
      }
    })
  }

  initPresetsAndPlugins () {
    const initialConfig = this.initialConfig
    const allConfigPresets = mergePlugins(this.optsPresets || [], initialConfig.presets || [])(PluginType.Preset)
    const allConfigPlugins = mergePlugins(this.optsPlugins || [], initialConfig.plugins || [])(PluginType.Plugin)
    createBabelRegister({
      only: [...Object.keys(allConfigPresets), ...Object.keys(allConfigPlugins)],
      babelConfig: initialConfig.babel,
      appPath: this.appPath
    })
    this.plugins = new Map()
    this.extraPlugins = []
    this.resolvePresets(allConfigPresets)
    this.resolvePlugins(allConfigPlugins)
  }

  resolvePresets (presets) {
    const allPresets = resolvePresetsOrPlugins(presets, PluginType.Preset)
    while (allPresets.length) {
      this.initPreset(allPresets.shift()!)
    }
  }

  resolvePlugins (plugins) {
    const allPlugins = resolvePresetsOrPlugins(plugins, PluginType.Plugin)
    const _plugins = [...this.extraPlugins, ...allPlugins]
    while (_plugins.length) {
      this.initPlugin(_plugins.shift()!)
    }
    this.extraPlugins = []
  }

  initPreset (preset: IPreset) {
    const { id, path, opts, apply } = preset
    const pluginCtx = this.initPluginCtx({ id, path, ctx: this })
    const { presets, plugins } = apply()(pluginCtx, opts) || {}
    this.registerPlugin(preset)
    if (Array.isArray(presets)) {
      const _presets = resolvePresetsOrPlugins(convertPluginsToObject(presets)(PluginType.Preset), PluginType.Preset)
      while (_presets.length) {
        this.initPreset(_presets.shift()!)
      }
    }
    if (Array.isArray(plugins)) {
      this.extraPlugins.push(...resolvePresetsOrPlugins(convertPluginsToObject(plugins)(PluginType.Plugin), PluginType.Plugin))
    }
  }

  initPlugin (plugin: IPlugin) {
    const { id, path, opts, apply } = plugin
    const pluginCtx = this.initPluginCtx({ id, path, ctx: this })
    this.registerPlugin(plugin)
    apply()(pluginCtx, opts)
  }

  registerPlugin (plugin: IPlugin) {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`插件 ${plugin.id} 已被注册`)
    }
    this.plugins.set(plugin.id, plugin)
  }

  initPluginCtx ({ id, path, ctx }: { id: string, path: string, ctx: Kernel }) {
    const pluginCtx = new Plugin({ id, path, ctx })
    const internalMethods = ['onReady', 'onStart']
    const kernelApis = ['appPath', 'plugins', 'paths', 'applyPlugins']
    internalMethods.forEach(name => {
      if (!this.methods.has(name)) {
        pluginCtx.registerMethod(name)
      }
    })
    kernelApis.forEach(name => {
      pluginCtx[name] = typeof this[name] === 'function' ? this[name].bind(this) : this[name]
    })
    this.methods.forEach((val, name) => {
      pluginCtx[name] = val
    })
    return pluginCtx
  }

  async applyPlugins (args: string | { name: string, initialVal?: any, opts?: any }) {
    let name
    let initialVal
    let opts
    if (typeof args === 'string') {
      name = args
    } else {
      name = args.name
      initialVal = args.initialVal
      opts = args.opts
    }
    if (typeof name !== 'string') {
      throw new Error(`调用失败，未传入正确的名称！`)
    }
    const hooks = this.hooks.get(name) || []
    const waterfall = new AsyncSeriesWaterfallHook(['arg'])
    if (hooks.length) {
      const resArr:any[] = []
      for (const hook of hooks) {
        waterfall.tapPromise({
          name: hook.plugin,
          stage: hook.stage || 0,
          before: hook.before
        }, async arg => {
          const res = await hook.fn(arg, opts)
          resArr.push(res)
          return resArr
        })
      }
    }
    return await waterfall.promise(initialVal)
  }

  runWithPlatform (platform) {
    if (!this.platforms.has(platform)) {
      throw `不存在编译平台 ${platform}`
    }
    const withNameConfig = this.config.getConfigWithNamed(platform, this.platforms.get(platform)!.useConfigName)
    return withNameConfig
  }

  async run (args: string | { name: string, opts?: any }) {
    let name
    let opts
    if (typeof args === 'string') {
      name = args
    } else {
      name = args.name
      opts = args.opts
    }
    await this.init()
    await this.applyPlugins('onStart')
    if (!this.commands.has(name)) {
      throw new Error(`${name} 命令不存在`)
    }
    if (opts.platform) {
      opts.config = this.runWithPlatform(opts.platform)
    }
    await this.applyPlugins({
      name,
      opts
    })
  }
}
