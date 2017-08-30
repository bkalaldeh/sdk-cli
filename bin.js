#! /usr/bin/env node
/**
 * Created by Daniel on 8/13/2015.
 */

var http = require('https');
var fs = require('fs');
var AdmZip = require('adm-zip');
var ncp = require('ncp').ncp;
var path = require("path");
var semver = require("semver");
var archiver = require('archiver');
var request = require('request');
var prompt = require('prompt');
var loginTrials = 0;
var baseApiUrl = 'http://uat.app.buildfire.com:89';
var apiProxy = 'http://localhost:8888';
ncp.limit = 32;


function rmdir(dir) {
    var list = fs.readdirSync(dir);
    for (var i = 0; i < list.length; i++) {
        var filename = path.join(dir, list[i]);
        var stat = fs.statSync(filename);

        if (filename == "." || filename == "..") {
            // pass these files
        } else if (stat.isDirectory()) {
            // rmdir recursively
            rmdir(filename);
        } else {
            // rm fiilename
            fs.unlinkSync(filename);
        }
    }
    //console.log('delete folder',dir);
    try {
        fs.rmdirSync(dir)
    }
    catch (e) {

    }
};

function downloadRepo(repoName, url) {
    if (!url)
        url = "https://github.com/BuildFire/" + repoName + "/archive/master.zip";
    var localZipPath = "_" + repoName + ".zip";

    var file = fs.createWriteStream(localZipPath);
    var request = http.get(url, function (response) {
        if (response.statusCode == 404) {
            console.error('invalid repo');
            return;
        }
        else if ([301, 302].indexOf(response.statusCode) > -1) {
            console.warn('file has been redirected');
            downloadRepo(repoName, response.headers.location);
            return;
        }

        console.log('begin downloading zip file...');
        response.pipe(file);
        file.on('finish', function () {
            console.log('downloaded zip.');
            file.close(function () {
                console.log('unzipping...');

                var zip = new AdmZip(localZipPath);
                zip.extractAllTo("./");
                console.log('delete zip file.');
                fs.unlink(localZipPath);
                console.log('move files to root...');
                ncp('./' + repoName + '-master', './', function (err) {
                    if (err) console.error(err);
                    console.log('clean up...');
                    rmdir('./' + repoName + '-master');
                });
            });


        })
    }).on('error', function (err) { // Handle errors
        console.error(err);
    });
}

function uploadPlugin(pluginPath, isUpdate) {
    var pluginName = null;
    try {
        if(pluginPath.indexOf('/') != 0 && pluginPath.indexOf('\\') != 0) {
            pluginName = require('./' + pluginPath + '/plugin.json').pluginName;
        } else {
            pluginName = require(pluginPath + '/plugin.json').pluginName;
        }
    }
    catch (err) {
        console.log('\x1b[41m', 'error fetching plugin.json; ' + err, '\x1b[0m');
        return;
    }

    console.log('\x1b[43m', 'plugin "' +  pluginName + '" is being prepared for uploading ...', '\x1b[0m');


    var zipPath = 'plugin-' + new Date().getTime() + '.zip';
    var archive = archiver('zip', {
        zlib: {level: 9} // Sets the compression level.
    });

    var output = fs.createWriteStream(zipPath);
    archive.pipe(output);
    archive.directory(pluginPath, false);
    output.on('close', function () {
        login(function (err, user) {
            if (err) {
                return console.log('\x1b[41m', 'error authenticating user', '\x1b[0m');
            }
            console.log('uploading plugin ...');
            if(!isUpdate) {
                publishUserPlugin(pluginName, zipPath, user, function(err, result) {
                    if(err) {
                        console.log('\x1b[41m', 'failed publishing plugin; ' + err, '\x1b[0m');
                    }
                    fs.unlink(zipPath);
                });
            } else {
                updateUserPlugin(pluginName, zipPath, user, function(err, result) {
                    if(err) {
                        console.log('\x1b[41m', 'failed updating plugin; ' + err, '\x1b[0m');
                    }
                    fs.unlink(zipPath);
                });
            }
        });
    });
    archive.finalize();
}

function login(callback) {
    prompt.start();
    prompt.get({
        properties: {
            username: {
                required: true,
                default: 'bkalaldeh@madaincorp.com'
            },
            password: {
                hidden: true,
                required: true,
                default: '123456'
            }
        }
    }, function (err, result) {
        if (err) {
            return; // user cancelled or input not captured
        }
        request({
                method: 'POST',
                preambleCRLF: true,
                postambleCRLF: true,
                proxy: apiProxy,
                uri: baseApiUrl + '/api/login/developerPortal/',
                headers: {
                    'Origin': baseApiUrl,
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Encoding': 'gzip, deflate'
                },
                body: {email: result.username, password: result.password},
                json: true
            },
            function (error, response, body) {
                if (body && body.auth) {
                    callback(null, body);
                } else {
                    loginTrials++;
                    if(loginTrials > 2) {
                        callback('failed logging in');
                        console.log('\x1b[41m', 'try logging in using the developer portal', '\x1b[0m');
                    } else {
                        console.log('\x1b[41m', 'could not authenticate user', '\x1b[0m');
                        login(callback);
                    }
                }
            });
    });
}

function publishUserPlugin(pluginName, zipPath, user, callback) {
    request({
            method: 'POST',
            preambleCRLF: true,
            postambleCRLF: true,
            proxy: apiProxy,
            uri: baseApiUrl + '/api/pluginTypes/',
            headers: {
                'Origin': baseApiUrl,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Encoding': 'gzip, deflate',
                'userToken': user.userToken,
                'auth': user.auth
            },
            formData: {
                file: fs.createReadStream(zipPath)
            }
        },
        function (error, response, body) {
            if (error) {
                return console.error('upload failed:', error);
            }
            if (response.statusCode >= 400 || response.statusCode == 0) {

                var jsonResult = undefined;
                try {
                    jsonResult = JSON.parse(body);
                }
                catch (err) {

                }
                if (jsonResult && jsonResult.message) {
                    if (jsonResult.code === 'checkPluginTypeUniqueness') {
                        console.log('\x1b[41m', 'a plugin already exists with the same name', '\x1b[0m');
                        prompt.start();
                        prompt.get({
                            properties: {
                                forceUpdate: {
                                    description: 'Update your exiting plugin',
                                    required: true,
                                    type: 'boolean',
                                    default: false
                                }
                            }
                        }, function (err, result) {
                            if (err) {
                                return; // do not update
                            }
                            if (result.forceUpdate) {
                                console.log('updating plugin ...');
                                updateUserPlugin(pluginName, zipPath, user, function(err, result) {
                                    callback(err, result)
                                });
                            }
                        });
                    } else {
                        callback(jsonResult.message);
                        console.log('\x1b[41m', 'failed: ' + jsonResult.message, '\x1b[0m');
                    }
                } else {
                    callback('an error has occurred');
                    console.log('\x1b[41m', 'an error has occurred: ', body, '\x1b[0m');
                }
            } else {
                callback(null, 'uploaded successfully');
                console.log('\x1b[45m', 'successfully uploaded plugin', '\x1b[0m');
            }
        });
}

function updateUserPlugin(pluginName, zipPath, user, callback) {

    getPluginType(pluginName, user, function(err, pluginType) {
        if(err) {
            callback(err);
            return;
        }
        request({
                method: 'POST',
                preambleCRLF: true,
                postambleCRLF: true,
                proxy: apiProxy,
                uri: baseApiUrl + '/api/pluginTypes/update',
                headers: {
                    'Origin': baseApiUrl,
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Encoding': 'gzip, deflate',
                    'userToken': user.userToken,
                    'auth': user.auth
                },
                formData: {
                    file: fs.createReadStream(zipPath),
                    pluginTypeToken: pluginType.token
                }
            },
            function (error, response, body) {
                if (error) {
                    return console.error('upload failed:', error);
                }
                if (response.statusCode >= 400 || response.statusCode == 0) {

                    var jsonResult = undefined;
                    try {
                        jsonResult = JSON.parse(body);
                    }
                    catch (err) {
                    }
                    if (jsonResult && jsonResult.message) {
                        callback(jsonResult.message);
                        console.log('\x1b[41m', 'failed: ' + jsonResult.message, '\x1b[0m');
                    } else {
                        callback('an error has occurred');
                        console.log('\x1b[41m', 'an error has occurred: ', body, '\x1b[0m');
                    }
                } else {
                    callback(null, 'uploaded successfully');
                    console.log('\x1b[45m', 'successfully updated plugin', '\x1b[0m');
                }
            });
    });
}

function getPluginType(pluginName, user, callback) {
    // TODO: replace with a dedicated api
    request({
            method: 'GET',
            proxy: apiProxy,
            uri: baseApiUrl + '/api/pluginTypes/search?pageIndex=1&pageSize=10',
            gzip: true,
            headers: {
                'Origin': baseApiUrl,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Encoding': 'gzip, deflate',
                'userToken': user.userToken,
                'auth': user.auth
            }
        },
        function (error, response, body) {
            var jsonResult = undefined;
            if (error) {
                return console.error('upload failed:', error);
            }
            if (response.statusCode >= 400 || response.statusCode == 0) {
                try {
                    jsonResult = JSON.parse(body);
                }
                catch (err) {
                }
                if (jsonResult && jsonResult.message) {
                    callback(jsonResult.message);
                    console.log('\x1b[41m', 'failed: ' + jsonResult.message, '\x1b[0m');
                } else {
                    callback('an error has occurred');
                    console.log('\x1b[41m', 'an error has occurred: ', body, '\x1b[0m');
                }
            } else {
                try {
                    jsonResult = JSON.parse(body);
                }
                catch (err) {
                    callback('parsing error');
                    return;
                }
                if (jsonResult && jsonResult.data) {
                    for(var index = 0; index < jsonResult.data.length; index++) {
                        if(jsonResult.data[index] && jsonResult.data[index].name == pluginName) {
                            callback(null, jsonResult.data[index]);
                            return;
                        }
                    }
                }
                callback('cannot find plugin type');
            }
        });
}

/// target : url or appid
function snapshots(target) {
    var options = {
        mode: 0
        , delay: 10000
        , resolutions: [{
            filename: 'images/iPhone4.png'
            , width: 640 / 2
            , height: 960 / 2
        },
            {
                filename: 'images/iPhone5.png'
                , width: 640 / 2
                , height: 1136 / 2
            },
            {
                filename: 'images/iPhone6.png'
                , width: 750 / 2
                , height: 1334 / 2
            },
            {
                filename: 'images/iPhone6Plus.png'
                , width: 1242 / 2
                , height: 2208 / 2
            },
            {
                filename: 'images/iPad.png'
                , width: 1536 / 2
                , height: 2048 / 2
            }, {
                filename: 'images/iPhonePro.png'
                , width: 2048 / 2
                , height: 2732 / 2
            }]
    };

    if (target.indexOf('http') != 0)
        options.appId = target;
    else
        options.url = target;

    var s = require('./tools/screenshot.js');
    s.capture(options, function (err, restults) {
        console.log('RESULTS ', restults.length);
    });

}


function checkVersion() {
    var minVersion = "1.0.0";
    var latestVersion = "1.0.0";
    var sdkNpmPackage = null;

    try {
        sdkNpmPackage = require('./package.json');
    }
    catch (err) {

    }

    if (!sdkNpmPackage || sdkNpmPackage.name != 'BuildFireSDK') {
        console.log('\x1b[43m', 'could not detect SDK on current path. You can use "create" command to download', '\x1b[0m');
        return;
    }

    var version = sdkNpmPackage.version;
    var isObsolete = semver.gt(minVersion, version);
    var isOutdated = semver.gt(latestVersion, version);

    console.log('detected SDK version: ' + version.toString());

    if (isObsolete) {
        console.log('\x1b[41m', 'current SDK version is obsolete. minimum version is (' + minVersion + ')', '\x1b[0m');
    } else {
        if (isOutdated) {
            console.log('\x1b[45m', 'SDK version (' + latestVersion + ') is available.', '\x1b[0m');
        }
    }
}

/* args
 node.exe
 path
 [command]
 */
if (process.argv.length < 3 || ['-help', 'help', '?', '/?'].indexOf(process.argv[2].toLowerCase()) >= 0) {
    console.log('==================================================');
    console.log('arguments:');
    console.log('* create: this will download the latest BuildFire SDK in the current folder');
    console.log('* update: this will download the latest BuildFire SDK and update the current folder');
    console.log('* plugin [plugin name]: this will download the latest version of the indicated plugin in the current folder');
    console.log('* snapshots [appId | url]: this will take pictures of the app home page or url requested at multiple resolutions');
    console.log('// many plugins are open source (MIT) feel free to Fork them on github http://github.com/buildfire');
}
else if (["create", "update"].indexOf(process.argv[2].toLowerCase()) >= 0)
    downloadRepo('sdk');
else if (["snapshots", "snapshot"].indexOf(process.argv[2].toLowerCase()) >= 0) {
    snapshots(process.argv[3]);
    checkVersion();
}
else if (process.argv[2].toLowerCase() == "plugin") {
    if (process.argv.length < 4)
        console.error('* you forgot to indicate which plugin');
    else {
        downloadRepo(process.argv[3]);
        checkVersion();
    }
}
else if (process.argv[2].toLowerCase() == "publish") {
    if (process.argv.length < 4)
        console.error('* you forgot to indicate which plugin');
    else {
        uploadPlugin(process.argv[3], process.argv[4] === '--update');
        checkVersion();
    }
}
else if (process.argv[2].toLowerCase() == "ver") {
    checkVersion();
}
else
    console.error('unknown command');

