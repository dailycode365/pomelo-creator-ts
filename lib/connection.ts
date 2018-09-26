import {EventEmitter} from "eventemitter3";
import * as is from 'is';


import {strdecode, Message, MessageType, Package, PackageType, strencode} from "./protocol";
import {init, encode, decode} from "./protobuf";

const moment = require('moment');


export const handshakeBuffer = {
    sys: {
        type: 'COCOS_CREATOR',
        version: '1.0.0',
        rsa: {},
        protoVersion: ''
    },
    user: {}
};

enum RESULT_CODE {
    RES_OK = 200,

    RES_FAIL = 500,
    RES_OLD_CLIENT = 501
}

export class ConnectionBase extends EventEmitter {
    public id: string = 'default';

    protected protoVersion: string = '';
    protected serverProtos: any = {};
    protected clientProtos: any = {};
    protected dict: any = {};
    protected routeMap: any = {};
    protected abbrs: any = {};

    protected encode: Function | undefined;
    protected decode: Function | undefined;

    protected heartbeatInterval: number = 0;
    protected heartbeatTimeout: number = 0;
    protected nextHeartbeatTimeout: number = 0;

    protected heartbeatTimeoutId: NodeJS.Timer | null = null;
    protected heartbeatId: NodeJS.Timer | null = null;
    protected callbacks: any = {};

    protected reqId: number = 0;

    public auth: () => Promise<boolean> = async function () {
        return false
    };

    protected autoReconnect: boolean = true;

    constructor() {

        super();

        this.on('reconnect', () => {
            console.log("socket reconnect!", this.autoReconnect, this.connected, this.connectting);
            if (!this.autoReconnect) {
                return;
            }
            if (this.connected || this.connectting) {
                return;
            }
            this.connect();
        });
    }

    public setItem(key: string, value?: any, ttl?: number) {
        console.log('更新本地缓存:', key, value);
        const localStorage = window ? window.localStorage : undefined;
        if (!localStorage) {
            console.error("找不到本地存储 api localStorage!");
            return;
        }
        if (is.empty(value)) {
            console.log("removeItem", key);
            localStorage.removeItem(key);
        } else {
            if (!!ttl) {
                console.log("本地存储", key);
                localStorage.setItem(key, JSON.stringify({
                    value,
                    expireat: moment().add(ttl, 'minute').format('YYYY-MM-DD hh:mm:dd')
                }));
            } else {
                localStorage.setItem(`connection.cookie.${this.id}.${key}`, JSON.stringify({value}));
            }
        }
    }

    public getItem(key: string) {
        const localStorage = window ? window.localStorage : undefined;
        if (!localStorage) {
            console.error("找不到本地存储 api localStorage!");
            return;
        }
        let data: any = localStorage.getItem(`connection.cookie.${this.id}.${key}`);
        if (data) {
            try {
                data = JSON.parse(data);
            } catch (_) {
            }
            if (data.expireat) {
                const expireat = moment(data.expireat);
                if (expireat.isValid() && expireat.isBefore(moment())) {
                    this.setItem(key);
                    console.log("获取本地参数", key, "已经失效!", data);
                    return;
                }
            }
        }
        if (data && data.value) {
            console.log("获取本地数据", key, data);
            return data.value;
        }
        console.log("找不到本地配置", key);
        return;
    }

    /**
     * 获取连接状态是否是正常连接状态
     */
    public get connected() {
        return 0;
    }

    /**
     * 获取连接状态 是否是连接中状态
     */
    public get connectting() {
        return 0;
    }

    /**
     * 发起连接初始化,并等待完成, 如果超时会触发 Promise.reject
     *
     * @param opts
     */
    public async connect(opts: any = {}) {
        if (this.connectting) {
            console.error("当前连接正在连接中...");
            return Promise.reject('connecting');
        }

        if (opts.auth) {
            this.auth = opts.auth;
        }

        handshakeBuffer.user = opts.user || {};

        this.encode = opts.encode || this.defaultEncode.bind(this);
        this.decode = opts.decode || this.defaultDecode.bind(this);

        const protos = this.getItem('protos');
        if (protos) {
            this.protoVersion = protos.version || '';
            this.serverProtos = protos.server || {};
            this.clientProtos = protos.client || {};

            init({
                encoderProtos: this.clientProtos,
                decoderProtos: this.serverProtos
            });
        }
        handshakeBuffer.sys.protoVersion = this.protoVersion;
        this.once('handshake', () => {
            this.send(Package.encode(PackageType.TYPE_HANDSHAKE, strencode(JSON.stringify(handshakeBuffer))));
        });
    }

    /**
     * 向服务器发起一个请求, 并等待完成后的返回值
     *
     * @param {string}route
     * @param {object}msg
     * @returns {Promise<object>}
     */
    public async request(route: string, msg: any = {}) {
        if (!this.connected) {
            if (!this.connectting) {
                return Promise.reject('socket hanup!');
            }
            await new Promise((resolve, reject) => {
                const timer = setTimeout(reject, 5000);
                this.once('ready', () => {
                    if (timer) {
                        clearTimeout(timer);
                    }
                    resolve();
                });
            });
        }

        this.reqId++;

        if (!!this.encode && is.function(this.encode)) {
            const body = this.encode(this.reqId, route, msg);
            if (body) {
                await this.send(Package.encode(PackageType.TYPE_DATA, body));
            }
        }
        return await new Promise((resolve, reject) => {
            this.callbacks[this.reqId] = {resolve, reject};
            this.routeMap[this.reqId] = route;
        });
    }

    /**
     * 通知服务器 --不关心返回值
     *
     * @param {string}route 消息rpc路由
     * @param {object}msg 消息内容, 默认值 {}
     * @returns {Promise<void>}
     */
    public async notify(route: string, msg: any = {}) {
        if (!this.connected) {
            if (!this.connectting) {
                return Promise.reject('socket hanup!');
            }
            await new Promise((resolve, reject) => {
                const timer = setTimeout(reject, 5000);
                this.once('ready', () => {
                    if (timer) {
                        clearTimeout(timer);
                    }
                    resolve();
                });
            });
        }

        if (this.encode) {
            const body = this.encode(0, route, msg);
            if (body) {
                await this.send(Package.encode(PackageType.TYPE_DATA, body));
            }
        }
        console.log('notify ', route, msg);
    }

    public async disconnect() {
        if (this.heartbeatId) {
            clearTimeout(this.heartbeatId);
            this.heartbeatId = null;
        }

        if (this.heartbeatTimeoutId) {
            clearTimeout(this.heartbeatTimeoutId);
            this.heartbeatTimeoutId = null;
        }
    }

    protected defaultEncode(reqId: number, route: string, msg: any = {}) {
        console.log("defaultEncode ", reqId, route);
        if (this.clientProtos[route]) {
            msg = encode(route, msg);
        } else {
            msg = strdecode(JSON.stringify(msg));
        }

        return Message.encode(reqId, reqId ? MessageType.TYPE_REQUEST : MessageType.TYPE_NOTIFY, this.dict[route], this.dict[route], msg);
    }

    protected defaultDecode(data: any) {
        const msg: any = Message.decode(data);
        if (msg.id > 0) {
            msg.route = this.routeMap[msg.id];
            delete this.routeMap[msg.id];
            if (!msg.route) {
                return;
            }
        }
        const canver = (msg: any) => {
            let route = msg.route;
            //Decompose route from dict
            if (msg.compressRoute) {
                if (!this.abbrs[route]) {
                    return {};
                }

                route = msg.route = this.abbrs[route];
            }
            if (this.serverProtos[route]) {
                return decode(route, msg.body);
            } else {
                return JSON.parse(strdecode(msg.body));
            }
        }
        msg.body = canver(msg);
        return msg;
    }

    protected async handshake(data: any) {
        data = JSON.parse(strdecode(data));
        if (data.code === RESULT_CODE.RES_OLD_CLIENT) {
            this.emit('error', 'client version not fullfill');
            return;
        }

        if (data.code !== RESULT_CODE.RES_OK) {
            console.error(`handshake failed by ${data.code}`);
            this.emit('error', `handshake failed by ${data.code}`);
            return;
        }
        if (data.sys && data.sys.heartbeat) {
            this.heartbeatInterval = data.sys.heartbeat * 1000;   // heartbeat interval
            this.heartbeatTimeout = this.heartbeatInterval * 5;        // max heartbeat timeout
        } else {
            this.heartbeatInterval = 0;
            this.heartbeatTimeout = 0;
        }

        this.dict = data.sys.dict;
        const protos = data.sys.protos;

        //Init compress dict
        if (this.dict) {
            this.abbrs = {};

            for (let route in this.dict) {
                this.abbrs[this.dict[route]] = route;
            }
        }

        //Init protobuf protos
        if (protos) {
            this.protoVersion = protos.version || 0;
            this.serverProtos = protos.server || {};
            this.clientProtos = protos.client || {};

            //Save protobuf protos to localStorage
            this.setItem('protos', JSON.stringify(protos));

            init({encoderProtos: protos.client, decoderProtos: protos.server});
        }
        this.send(Package.encode(PackageType.TYPE_HANDSHAKE_ACK));
    }

    protected async send(binary: any) {
        console.log("发送网络消息:", binary.length);
    }

    protected async processPackage(data: any) {
        let msgs: any = Package.decode(data);
        console.log("解析消息:", msgs);
        if (!msgs) {
            return this.disconnect();
        }
        if (!is.array(msgs)) {
            msgs = [msgs];
        }

        for (let i in msgs) {
            const msg = msgs[i];
            console.log("处理消息:", msg.type);
            switch (msg.type) {
                case PackageType.TYPE_HANDSHAKE: {
                    await this.handshake(msg.body);
                    this.emit('connected');
                    if (!!this.auth && is.function(this.auth)) {
                        const ok: boolean = await this.auth();
                        if (ok) {
                            this.emit('ready');
                        }
                    }
                }
                    break;
                case PackageType.TYPE_HEARTBEAT: {
                    if (!this.heartbeatInterval || this.heartbeatId) {
                        return;
                    }
                    if (this.heartbeatTimeoutId) {
                        clearTimeout(this.heartbeatTimeoutId);
                        this.heartbeatTimeoutId = null;
                    }
                    this.heartbeatId = setTimeout(() => {
                        this.heartbeatId = null;
                        this.send(Package.encode(PackageType.TYPE_HEARTBEAT));

                        this.nextHeartbeatTimeout = Date.now() + this.heartbeatTimeout;
                        this.heartbeatTimeoutId = setTimeout(() => {
                            this.emit('timeout');
                            this.disconnect();
                        }, this.heartbeatTimeout);
                    }, this.heartbeatInterval);
                }
                    break;
                case PackageType.TYPE_DATA: {
                    let body = null;
                    if (!!this.decode) {
                        body = this.decode(msg.body);
                    }

                    if (!body.id) {
                        console.log("收到服务器推送消息:", body.route, body.body);
                        this.emit(body.route, body.body);
                        return;
                    }

                    if (this.callbacks[body.id]) {
                        this.callbacks[body.id].resolve(body.body);
                        delete this.callbacks[body.id];
                        console.log("请求消息返回:", body.id, body.body);
                    }
                }
                    break;
                case PackageType.TYPE_KICK: {
                    console.warn("服务器主动断开连接", JSON.parse(strdecode(msg.body)));
                    this.emit('onKick', JSON.parse(strdecode(msg.body)));
                }
                    break;
                default:
                    console.error('un-support protocol', msg);
                    break;
            }
        }
    }

}