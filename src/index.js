'use strict';

var path = require('path'),
    fs = require('fs'),
    async = require('async'),
    glob = require('glob-array'),
    raml = require('raml-1-parser'),
    _ = require('lodash'),
    schemaMocker = require('./schema.js'),
    RequestMocker = require('./requestMocker.js');

function generate(options, callback) {
    if (options) {
        if (!callback || !_.isFunction(callback)) {
            console.error('[RAML-MOCKER] You must define a callback function:\n');
            showUsage();
        }
        try {
            if (options.path) {
                generateFromPath(options.path, options, callback);
            } else if (options.files && _.isArray(options.files)) {
                generateFromFiles(options.files, options, callback);
            }
        } catch (exception) {
            console.error('[RAML-MOCKER] A runtime error has ocurred:\n');
            console.error(exception.stack);
            showUsage();
        }
    } else {
        console.error('[RAML-MOCKER] You must define a options object:\n');
        showUsage();
    }
}

function showUsage() {
    console.log('--------------------------------------------------------------------');
    console.log('---------------------- HOW TO USE RAML MOCKER ----------------------');
    console.log('--  var ramlMocker = require(\'raml-mocker\');                      --');
    console.log('--  var options = { path: \'test/raml\' };                          --');
    console.log('--  var callback = function (requests){ console.log(requests); }; --');
    console.log('--  ramlMocker.generate(options, callback);                       --');
    console.log('--------------------------------------------------------------------');
}

function generateFromPath(filesPath, options, callback) {
    fs.readdir(filesPath, function(err, files) {
        if (err) {
            throw err;
        }
        var filesToGenerate = [];
        _.each(files, function(file) {
            if (file.substr(-5) === '.raml') {
                filesToGenerate.push(path.join(filesPath, file));
            }
        });
        generateFromFiles(filesToGenerate, options, callback);
    });
}

function generateFromFiles(files, options, callback) {
    var requestsToMock = [];
    var files = glob.sync(files, {});
    var formats = options.formats || {};

    async.each(files, function(file, cb) {

        raml.loadApi(file ).then(function(api) {
            var data = api.toJSON();
            var uri = '/' + (options.useApiVersion ? (data.version || '') + '/' : '');

            getRamlRequestsToMock(data, uri, formats, file , function(reqs) {
                requestsToMock = _.union(requestsToMock, reqs);
                cb();
            });
        }, function(error) {
            cb('Error parsing: ' + error);
        });
    }, function(err) {
        if (err) {
            console.log(err);
        } else {
            callback(requestsToMock);
        }
    });
}

function getRamlRequestsToMock(definition, uri, formats, ramlfile , callback) {

    var requestsToMock = [];
    if (definition.relativeUri) {
        var nodeURI = definition.relativeUri;
        if (definition.uriParameters) {
            _.each(definition.uriParameters, function(uriParam, name) {
                nodeURI = nodeURI.replace('{' + name + '}', ':' + name);
            });
        }
        uri = (uri + '/' + nodeURI).replace(/\/{2,}/g, '/');
    }
    var tasks = [];
    if (definition.methods) {
        tasks.push(function(cb) {
            getRamlRequestsToMockMethods(definition, uri, formats, ramlfile, function(reqs) {
                requestsToMock = _.union(requestsToMock, reqs);
                cb();
            });
        });
    }
    if (definition.resources) {
        tasks.push(function(cb) {
            getRamlRequestsToMockResources(definition, uri, formats, ramlfile, function(reqs) {
                requestsToMock = _.union(requestsToMock, reqs);
                cb();
            });
        });
    }
    async.parallel(tasks, function(err) {
        if (err) {
            console.log(err);
        }
        callback(requestsToMock);
    });
}

function getRamlRequestsToMockMethods(definition, uri, formats, ramlfile, callback) {
    var responsesByCode = [];
    _.each(definition.methods, function (method) {
        if (method.method && /get|post|put|delete/i.test(method.method) && method.responses) {
            var responsesMethodByCode = getResponsesByCode(method.responses);

            var methodMocker = new RequestMocker(uri, method.method);

            var currentMockDefaultCode = null;
            _.each(responsesMethodByCode, function (reqDefinition) {
                methodMocker.addResponse(reqDefinition.code, function () {
                    if (reqDefinition.schema) {
                        return schemaMocker(reqDefinition.schema, formats, ramlfile);
                    } else {
                        return null;
                    }
                }, function () {
                    return reqDefinition.example;
                });
                if ((!currentMockDefaultCode || currentMockDefaultCode > reqDefinition.code) && /^2\d\d$/.test(reqDefinition.code)) {
                    methodMocker.mock = methodMocker.getResponses()[reqDefinition.code];
                    methodMocker.example = methodMocker.getExamples()[reqDefinition.code];
                    currentMockDefaultCode = reqDefinition.code;
                }
            });
            if (currentMockDefaultCode) {
                methodMocker.defaultCode = currentMockDefaultCode;
            }
            responsesByCode.push(methodMocker);
        }
    });
    callback(responsesByCode);
}

function getResponsesByCode(responses) {
    var responsesByCode = [];
    _.each(responses, function(response, code) {
        if (!response) return;
        var body = response.body && response.body['application/json'];
        // it validates any possible media vendor type
        for (var key in response.body) {
            if (response.body.hasOwnProperty(key) && key.match(/application\/[A-Za-z.-0-1]*\+?(json|xml)/)) {
                body = response.body[key];
                break;
            }
        }
        var schema = null;
        var example = null;
        if (!_.isNaN(Number(code)) && body) {
            code = Number(code);
            example = body.example;
            try {
                schema = body.schema && JSON.parse(body.schema);
            } catch (exception) {
                console.warn('Unable to parse ', body.schema.red ,'schema Please use', '!include schemas/<file-name>'.green, 'instead');
                console.error(exception);
            }
            responsesByCode.push({
                code: code,
                schema: schema,
                example: example
            });
        }
    });
    return responsesByCode;
}

function getRamlRequestsToMockResources(definition, uri, formats, ramlfile, callback) {
    var requestsToMock = [];
    async.each(definition.resources, function(def, cb) {
        getRamlRequestsToMock(def, uri, formats, ramlfile, function(reqs) {
            requestsToMock = _.union(requestsToMock, reqs);
            cb(null);
        });
    }, function(err) {
        if (err) {
            console.log(err);
        }
        callback(requestsToMock);
    });
}
module.exports = {
    generate: generate
};
