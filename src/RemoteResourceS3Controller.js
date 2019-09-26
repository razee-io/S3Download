/**
 * Copyright 2019 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const objectPath = require('object-path');
const request = require('request-promise-native');
const merge = require('deepmerge');
const log = require('./bunyan-api').createLogger('RemoteResourceS3Controller');
const { BaseDownloadController } = require('@razee/razeedeploy-core');


module.exports = class RemoteResourceS3Controller extends BaseDownloadController {
  constructor(params) {
    params.finalizerString = params.finalizerString || 'children.downloads.deploy.razee.io';
    super(params);
  }

  _fixUrl(u) {
    if (u.pathname.charAt(u.pathname.length - 1) === '/') { //This is an S3 bucket
      if (u.hostname.startsWith('s3.')) { //The bucket name is part of the path
        let pathSegments = u.pathname.split('/');
        pathSegments.shift(); //Discard the leading slash
        u.pathname = pathSegments.shift();
        u.search = `prefix=${pathSegments.join('/')}`;
      } else { //The bucket name is part of the hostname
        let hostnameSegments = u.hostname.split('.');
        let bucket = hostnameSegments.shift();
        u.hostname = hostnameSegments.join('.');
        let prefix = u.pathname.slice(1, u.pathname.length);
        u.search = `prefix=${prefix}`;
        u.pathname = bucket;
      }
    }
    return u;
  }

  async _getObjectList(bucketRequest) {
    let result = [];
    let url = this._fixUrl(objectPath.get(bucketRequest, 'options.url'));
    //get and parse xml
    //  clone bucketRequest
    //  set url to what is needed to get the object
    //  result.push(clonedRequest)
    return result;
  }

  async added() {
    let requests = objectPath.get(this.data, ['object', 'spec', 'requests'], []);
    let newRequests = [];
    requests.forEach((r) => {
      let url = objectPath.get(r, 'options.url');
      if (url.endsWith('/')) {
        let additionalRequests = this._getBucketObjectRequestList(r);
        // remove url that ends with '/'
        newRequests.concat(additionalRequests);
      } else {
        newRequests.push(r);
      }
    });
    objectPath.set(this.data, ['object', 'spec', 'requests'], newRequests);
    return await super.added();
  }

  async download(reqOpt) {
    let hmac = objectPath.get(this.data, ['object', 'spec', 'auth', 'hmac']);
    let iam = objectPath.get(this.data, ['object', 'spec', 'auth', 'iam']);
    let options = {};
    if (hmac) {
      if (typeof hmac.access_key_id == 'object') {
        let secretName = objectPath.get(hmac, 'access_key_id.valueFrom.secretKeyRef.name');
        let secretNamespace = objectPath.get(hmac, 'access_key_id.valueFrom.secretKeyRef.namespace', this.namespace);
        let secretKey = objectPath.get(hmac, 'access_key_id.valueFrom.secretKeyRef.key');
        hmac.access_key_id = await this._getSecretData(secretName, secretKey, secretNamespace);
      }
      objectPath.set(options, 'aws.key', hmac.access_key_id);
      if (typeof hmac.secret_access_key == 'object') {
        let secretName = objectPath.get(hmac, 'secret_access_key.valueFrom.secretKeyRef.name');
        let secretNamespace = objectPath.get(hmac, 'secret_access_key.valueFrom.secretKeyRef.namespace', this.namespace);
        let secretKey = objectPath.get(hmac, 'secret_access_key.valueFrom.secretKeyRef.key');
        hmac.secret_access_key = await this._getSecretData(secretName, secretKey, secretNamespace);
      }
      objectPath.set(options, 'aws.secret', hmac.secret_access_key);
    } else if (iam) {
      let bearerToken = await this._fetchS3Token(iam);
      objectPath.set(options, 'headers.Authorization', `bearer ${bearerToken}`);
    }
    let opt = merge(reqOpt, options);
    log.debug(`Download ${opt.uri || opt.url}`);

    opt.simple = false;
    opt.resolveWithFullResponse = true;

    return await request(opt);
  }

  async _fetchS3Token(iam) {
    let apiKey = objectPath.get(iam, 'api_key', '');
    if (typeof apiKey == 'object') {
      let secretName = objectPath.get(apiKey, 'valueFrom.secretKeyRef.name');
      let secretNamespace = objectPath.get(apiKey, 'valueFrom.secretKeyRef.namespace', this.namespace);
      let secretKey = objectPath.get(apiKey, 'valueFrom.secretKeyRef.key');
      apiKey = await this._getSecretData(secretName, secretKey, secretNamespace);
    }
    if (apiKey == '') {
      return Promise.reject('Failed to find valid api_key to authenticate against iam');
    }
    let res = await request.post({
      form: {
        apikey: apiKey,
        response_type: iam.response_type,
        grant_type: iam.grant_type
      },
      timeout: 60000,
      url: iam.url,
      json: true
    });
    return res.access_token;
  }

  async _getSecretData(name, key, ns) {
    let res = await this.kubeResourceMeta.request({ uri: `/api/v1/namespaces/${ns || this.namespace}/secrets/${name}`, json: true });
    let apiKey = Buffer.from(objectPath.get(res, ['data', key], ''), 'base64').toString();
    return apiKey;
  }


};
