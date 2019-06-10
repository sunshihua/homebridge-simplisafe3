// © 2019 Niccolò Zapponi
// SimpliSafe 3 API Wrapper

import axios from 'axios';
import io from 'socket.io-client';

// Do not touch these - they allow the client to make requests to the SimpliSafe API
const clientUsername = '4df55627-46b2-4e2c-866b-1521b395ded2.1-28-0.WebApp.simplisafe.com';
const clientPassword = '';

const ssApi = axios.create({
    baseURL: 'https://api.simplisafe.com/v1'
});

const validAlarmStates = [
    'off',
    'home',
    'away'
];

class SimpliSafe3 {

    token;
    rToken;
    tokenType;
    expiry;
    username;
    password;
    userId;
    subId;
    socket;

    async login(username, password, storeCredentials = false) {

        if (storeCredentials) {
            this.username = username;
            this.password = password;
        }

        try {
            const response = await ssApi.post('/api/token', {
                username: username,
                password: password,
                grant_type: 'password'
            }, {
                auth: {
                    username: clientUsername,
                    password: clientPassword
                }
            });

            let data = response.data;
            this._storeLogin(data);
        } catch (err) {
            let response = (err.response && err.response) ? err.response : err;
            this.logout(storeCredentials);

            throw response;
        }
    }

    _storeLogin(tokenResponse) {
        this.token = tokenResponse.access_token;
        this.rToken = tokenResponse.refresh_token;
        this.tokenType = tokenResponse.token_type;
        this.expiry = Date.now() + (tokenResponse.expires_in * 1000);
    }

    logout(keepCredentials = false) {
        this.token = null;
        this.rToken = null;
        this.tokenType = null;
        this.expiry = null;
        if (!keepCredentials) {
            this.username = null;
            this.password = null;
        }
    }

    isLoggedIn() {
        return this.refreshToken !== null || (this.token !== null && Date.now() < this.expiry);
    }

    async refreshToken() {
        if (!this.isLoggedIn() || !this.refreshToken) {
            return Promise.reject('User is not logged in');
        }

        try {
            const response = await ssApi.post('/api/token', {
                refresh_token: this.rToken,
                grant_type: 'refresh_token'
            }, {
                auth: {
                    username: clientUsername,
                    password: clientPassword
                }
            });

            let data = response.data;
            this._storeLogin(data);

        } catch (err) {
            let response = (err.response) ? err.response : err;
            this.logout(this.username != null);

            throw response;
        }
    }

    async request(params, tokenRefreshed = false) {
        if (!this.isLoggedIn) {
            return Promise.reject('User is not logged in');
        }

        try {
            const response = await ssApi.request({
                ...params,
                headers: {
                    ...params.headers,
                    Authorization: `${this.tokenType} ${this.token}`
                }
            });
            return response.data;
        } catch (err) {
            let statusCode = err.response.status;
            if (statusCode == 401 && !tokenRefreshed) {
                return this.refreshToken()
                    .then(() => {
                        return this.request(params, true);
                    })
                    .catch(async err => {
                        let statusCode = err.status;
                        if ((statusCode == 401 || statusCode == 403) && this.username && this.password) {
                            try {
                                await this.login(this.username, this.password, true);
                                return this.request(params, true);
                            }
                            catch (err) {
                                throw err;
                            }
                        } else {
                            throw err;
                        }
                    });
            } else {
                throw err.response.data;
            }
        }
    }

    async getUserId() {
        if (this.userId) {
            return this.userId;
        }

        try {
            let data = await this.request({
                method: 'GET',
                url: '/api/authCheck'
            });
            this.userId = data.userId;
            return this.userId;
        } catch (err) {
            throw err;
        }
    }

    async getUserInfo() {
        try {
            let userId = await this.getUserId();

            let data = await this.request({
                method: 'GET',
                url: `/users/${userId}/loginInfo`
            });

            return data.loginInfo;
        } catch (err) {
            throw err;
        }
    }

    async getSubscriptions() {
        try {
            let userId = await this.getUserId();
            let data = await this.request({
                method: 'GET',
                url: `/users/${userId}/subscriptions?activeOnly=false`
            });

            let subscriptions = data.subscriptions;

            if (subscriptions.length == 1) {
                this.subId = subscriptions[0].sid;
            }

            return subscriptions;
        } catch (err) {
            throw err;
        }
    }

    async getSubscription(subId = null) {
        try {

            let subscriptionId = subId;

            if (!subscriptionId) {
                subscriptionId = this.subId;

                if (!subscriptionId) {
                    let subs = await this.getSubscriptions();
                    if (subs.length == 1) {
                        subscriptionId = subs[0].sid;
                    } else {
                        throw new Error('Subscription ID is ambiguous');
                    }
                }
            }

            let data = await this.request({
                method: 'GET',
                url: `/subscriptions/${subscriptionId}/`
            });

            return data.subscription;
        } catch (err) {
            throw err;
        }
    }

    setDefaultSubscription(subId) {
        if (!subId) {
            throw new Error('Subscription ID not defined');
        }

        this.subId = subId;
    }

    async getAlarmState() {
        try {
            let subscription = await this.getSubscription();

            if (subscription.location && subscription.location.system) {
                // OFF, HOME, AWAY, AWAY_COUNT, HOME_COUNT, ALARM_COUNT, ALARM
                return subscription.location.system.isAlarming ? 'ALARM' : subscription.location.system.alarmState;
            } else {
                throw new Error('Subscription format not understood');
            }

        } catch (err) {
            throw err;
        }
    }

    async setAlarmState(newState) {
        let state = newState.toLowerCase();

        if (validAlarmStates.indexOf(state) == -1) {
            throw new Error('Invalid target state');
        }

        try {
            if (!this.subId) {
                await this.getSubscription();
            }

            let data = await this.request({
                method: 'POST',
                url: `/ss3/subscriptions/${this.subId}/state/${state}`
            });
            return data;
        } catch (err) {
            throw err;
        }
    }

    async getEvents(params) {

        try {
            if (!this.subId) {
                await this.getSubscription();
            }

            let url = `/subscriptions/${this.subId}/events`;
            if (Object.keys(params).length > 0) {
                let query = Object.keys(params).map(key => `${key}=${params[key]}`);
                url = `${url}?${query.join('&')}`;
            }

            let data = await this.request({
                method: 'GET',
                url: url
            });

            let events = data.events;
            return events;

        } catch (err) {
            throw err;
        }
    }

    async getSensors(forceUpdate = false) {

        try {
            if (!this.subId) {
                await this.getSubscription();
            }

            let data = await this.request({
                method: 'GET',
                url: `/ss3/subscriptions/${this.subId}/sensors?forceUpdate=${forceUpdate ? 'true' : 'false'}`
            });

            return data.sensors;
        } catch (err) {
            throw err;
        }
    }

    async subscribe(callback) {

        let _socketCallback = data => {
            switch (data.eventCid) {
                case 1400:
                case 1407:
                    // OFF (1400 is for Master PIN, 1407 is for Remote)
                    callback('OFF', data);
                    break;
                case 9441:
                    // HOME_COUNT
                    callback('HOME_COUNT', data);
                    break;
                case 3441:
                    // HOME
                    callback('HOME', data);
                    break;
                case 9401:
                case 9407:
                    // AWAY_COUNT (9401 is for Keypad, 9407 is for Remote)
                    callback('AWAY_COUNT', data);
                    break;
                case 3401:
                case 3407:
                    // AWAY (3401 is for Keypad, 3407 is for Remote)
                    callback('AWAY', data);
                    break;
                case 1429:
                    // ENTRY DETECTED
                    callback('ENTRY', data);
                    break;
                case 1170:
                    // CAMERA DETECTED MOTION
                    callback('MOTION', data);
                    break;
                case 1602:
                    // Automatic test
                    break;
                default:
                    callback(null, data);
                    break;
            }
        };

        if (this.socket) {
            this.socket.on('event', _socketCallback);
        } else {
            try {
                let userId = await this.getUserId();
    
                this.socket = io(`https://api.simplisafe.com/v1/user/${userId}`, {
                    path: '/socket.io',
                    query: {
                        ns: `/v1/user/${userId}`,
                        accessToken: this.token
                    },
                    transports: ['websocket', 'polling']
                });

                this.socket.on('connect_error', () => {
                    this.socket = null;
                });

                this.socket.on('connect_timeout', () => {
                    this.socket = null;
                });

                this.socket.on('error', () => {
                    this.socket = null;
                });

                this.socket.on('event', _socketCallback);
    
            } catch (err) {
                throw err;
            }
        } 

    }

    isSocketConnected() {
        return this.socket && this.socket.connected;
    }

    unsubscribe() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }

}

export default SimpliSafe3;