/* globals L:true */
// jshint laxbreak:true

L.ShadowWrap = {};
L.ShadowWrap.minimumWrapDistance = 0;
L.ShadowWrap.EventsToShadow = ['contextmenu', 'click', 'dblclick', 'mousedown', 'mouseover', 'mouseout'];

// a brief overview of what's going on here.
//
// the problem this plugin is trying to solve is that if a shape crosses over a wrap line on a
// leaflet map (e.g. the international dateline on a map of earth), then the shape will mysteriously disappear
// when a user pans over the wrap line. on one side it is there, and seems to cross the wrap line just fine,
// and then poof, its gone.
//
// this strange situation is because leaflet clips shapes that are outside of its display zone. say you
// have a shape that spans from -88lat to 88lat (antarctic to artic) and 170 lng to 190lng. longitude wraps
// from -180 to 180, so 190lng is translated into -170lng. (170lng = eastern russia, -170lng = alaska) now
// imagine you're looking at it zoomed all the way out, so you can see pretty much a whole hemisphere
// of the earth. if you look at russia, you see this shape just fines, but as you pan east to california,
// it'll disappear because it is displayed on a pane tied to coordinates 360 degrees away. 
//
// so, what this plugin does is create a "shadow" copy of a shape whenever it happens to cross a wrap line.
// the shadow(s) will be added to whatever the main shape is added to, and events on the shadow are forwarded
// to the corresponding one on the main shape. (e.g. clicks, etc). furthermore, updates on the main shape
// (coordinate changes, style changes, etc) will be reflected in the shadow.
//
// this is all set up transparently by wrapping various shape methods with some extra code that checks for,
// and creates, these shadows. what methods are wrapped, and how, is specified in the table below.
//
// you can also change the table, if you so desire. a rundown of the different shadow method types:
//
// (unmentioned) - these will execute like normal, without involving the shadow in anyways. e.g., getLatLng
//                 on a circle will return the latlng of the center of the main circle
//
//  simple - if the shape has a shadow, then when a call to this method is reached then execution will split
//           to any shadows it has. note that further encountered shadow methods will not cause another split
//           all arguments are passed through to the original method unchanged
//
//  translated - like simple, but the second argument of these methods, a latlng, will be translated according
//               to its shadow type (normalizeLL for the main shape)
//
//  translateRechecked - like translate, but then the shape's latlngs are checked afterwards to see if any
//                       new shadows need to be created or removed
//
//  multiLatlngs - like translateRechecked, but special-purposed for arrays of latlngs. also note this has to
//                 deal with a bit of extra wackiness because L.Polygon._setLatLngs and L.Polygon._convertLatLngs
//                 both dispatch to its prototype in L.Polyline
//
//  special - only one method, L.Rectangle._boundsToLatLngs, is in this category. it adds a wrapper whose
//            purpose is to allow an array of coordinate tuples to be passed to the rect's initialize method,
//            as with polygon and polyine's init method. this category also exists if there's any custom methods
//            that one needs to implement that are defined on the various shapes. 

L.ShadowWrap.MethodsToWrap = {
    'L.Layer': {
        'translated': [['openTooltip', 1], ['openPopup', 1]],
        'simple': [
            'bindTooltip', 'unbindTooltip', 'closeTooltip', 'toggleTooltip',
            'bindPopup', 'unbindPopup', 'closePopup', 'togglePopup'
        ],
    },
    
    'L.Path': {
        'simple': ['bringToBack', 'bringToFront', 'setStyle', 'redraw', '_reset'],
    },
    
    'L.Polyline': {
        'addInitHook': true,
        'shadowCheckType': 'cross',
        
        'simple': ['_update'],
        'multiLatlngs': ['_setLatLngs', '_convertLatLngs'],
        'translateRechecked': [['addLatLng', 0]],
    },
    
    'L.Polygon': {
        'shadowCheckType': 'cross',
        'multiLatlngs': ['_setLatLngs', '_convertLatLngs'],
    },
    
    'L.Rectangle': {
        'shadowCheckType': 'cross',
        'special': ['_boundsToLatLngs'],
    },
    
    'L.Marker': {
        'shadowCheckType': 'point',
        'simple': ['setZIndexOffset', 'setIcon', '_setPos', 'update', 'setOpacity'],
        'translateRechecked': [['setLatLng', 0]],
    },
    
    'L.CircleMarker': {
        'addInitHook': true,
        'shadowCheckType': 'circle',
        
        'simple': ['setStyle', '_updateBounds', '_update'],
        'rechecked': ['setRadius'],
        'translateRechecked': [['setLatLng', 0]],
    },
    
    'L.Circle': {
        'shadowCheckType': 'circle',
        
        'simple': ['_project'],
        'rechecked': ['setRadius'],
        'translateRechecked': [['setLatLng', 0]],
    }
};

// *************************************************************************************
// *************************************************************************************

// a very hackish setup designed to help plugins that muck with the internals of shapes
// the idea is that you can block shadow dispatching in very specific cases
// for example:
//     L.ShadowWrap.addShadowException('Path', 'setStyle', L.Edit.SimpleShape.prototype.removeHooks);
//     L.ShadowWrap.addShadowException('Path', 'setStyle', L.Edit.PolyVerticesEdit.prototype.removeHooks);
//
// blocks shadow dispatching of 'setStyle' by LeafletDraw when called from L.Edit.SimpleShape.prototype.removeHooks
// or L.Edit.PolyVerticesEdit.prototype.removeHooks so that the shadow shape doesn't get its style reverted
// when entering or leaving edit mode when those functions loop over all shapes in drawnItems.

L.ShadowWrap.shadowExceptions = {};
L.ShadowWrap.addShadowException = function (className, methodName, exception) {
    className = className.replace('L.', '');
    
    if (! L.ShadowWrap.shadowExceptions[className].hasOwnProperty(methodName)) {
        L.ShadowWrap.shadowExceptions[className][methodName] = [];
    }
    
    L.ShadowWrap.shadowExceptions[className][methodName].push(exception);
};

L.ShadowWrap.removeShadowException = function (className, methodName, exceptionToRemove) {
    className = className.replace('L.', '');
    
    if (! L.ShadowWrap.shadowExceptions[className].hasOwnProperty(methodName)) {
        return;
    }
    
    var cleaned = [];
    for (var i=0; i<L.ShadowWrap.shadowExceptions[className][methodName].length; i++) {
        var m = L.ShadowWrap.shadowExceptions[className][methodName];
        if (m != exceptionToRemove) {
            cleaned.push(m);
        }
    }
    
    L.ShadowWrap.shadowExceptions[className][methodName] = cleaned;
};

L.ShadowWrap.checkExceptions = function (className, methodName, obj) {
    if (L.ShadowWrap.shadowExceptions[className].hasOwnProperty(methodName)) {
        var exs = L.ShadowWrap.shadowExceptions[className][methodName];
        for (var i=0; i<exs.length; i++) {
            if (obj[methodName].caller === exs[i]) {
                return true;
            }
        }
    }
    
    return false;
};

// ***************************************************************************************
// ***************************************************************************************

// the shadow constructor, which sounds like the name of one hell of a chinese webnovel
L.ShadowWrap.initializeShadowHooks = function () {
    if (this.options.hasOwnProperty('noShadow')) {
        return;
    }

    if (this.hasOwnProperty('shadowOptions')) {
        return;
    }
    
    this.shadowOptions = {
        'isShape': true,
        'shadowShapes': {},
        'shadowSplit': false,
        'secondaryExecutor': false
    };
    
    if (this.options.hasOwnProperty('isShadow') && (this.options.isShadow === true)) {
        return;
    }

    this.shadowOptions.shadowType = 'normalizeLL';    
    this.shadowOptions.isShadow = false;
    
    this.on('add', this.addShadows, this);
    this.on('remove', this.removeAllShadows, this);
};

// see the huge table and corresponding comment at the top of this file to understand what this is doing
L.ShadowWrap.installShadowHooks = function (className, classSettings) {
    className = className.replace('L.', '');
    
    var i;
    var methodName;
    var translationIndex;
    var cls = L[className];
    
    L.ShadowWrap.shadowExceptions[className] = {};
    if (classSettings.hasOwnProperty('addInitHook') && (classSettings.addInitHook === true)) {
        cls.addInitHook(L.ShadowWrap.initializeShadowHooks);
    }
    
    if (classSettings.hasOwnProperty('shadowCheckType')) {
        cls.prototype.options.shadowCheckType = classSettings.shadowCheckType;
    }
  
    if (classSettings.hasOwnProperty('simple')) {
        for (i=0; i<classSettings.simple.length; i++) {
            methodName = classSettings.simple[i];
            L.ShadowWrap.installShadowMethod(cls, className, methodName, null, false);
        }
    }
        
    if (classSettings.hasOwnProperty('rechecked')) {
        for (i=0; i<classSettings.rechecked.length; i++) {
            methodName = classSettings.rechecked[i];
            L.ShadowWrap.installShadowMethod(cls, className, methodName, null, true);
        }
    }
        
    if (classSettings.hasOwnProperty('translated')) {
        for (i=0; i<classSettings.translated.length; i++) {
            methodName = classSettings.translated[i][0];
            translationIndex = classSettings.translated[i][1];
            L.ShadowWrap.installShadowMethod(cls, className, methodName, translationIndex, false);
        }
    }
        
    if (classSettings.hasOwnProperty('translateRechecked')) {
        for (i=0; i<classSettings.translateRechecked.length; i++) {
            methodName = classSettings.translateRechecked[i][0];
            translationIndex = classSettings.translateRechecked[i][1];
            L.ShadowWrap.installShadowMethod(cls, className, methodName, translationIndex, true);
        }
    }
        
    if (classSettings.hasOwnProperty('multiLatlngs')) {
        for (i=0; i<classSettings.multiLatlngs.length; i++) {  
            methodName = classSettings.multiLatlngs[i];
            L.ShadowWrap.installInheritedShadowMethod(cls, className, methodName);
        }
    }
        
    if (classSettings.hasOwnProperty('special')) {
        for (i=0; i<classSettings.special.length; i++) {
            methodName = classSettings.special[i];
            cls.prototype[methodName + '__original'] = cls.prototype[methodName];
            cls.prototype[methodName] = L.ShadowWrap.SpecialMethods[methodName];
        }
    }
};

// *************************************************************************************
// *************************************************************************************

L.ShadowWrap.installShadowMethod = function (cls, className, methodName, translate, recheck) {
    var dispatchedMethodName = methodName + '__original' + className;
    var isSingle = (cls.prototype.options.shadowCheckType != 'cross');
    
    // set the original method name to methodName__original and e.g.
    // methodName__originalRectangle, or whatever the className is
    // the first one is so that we can still manually call a few things later on, like __update,
    // without needing to figure out what class we want
    cls.prototype[methodName + '__original'] = cls.prototype[methodName];
    cls.prototype[dispatchedMethodName] = cls.prototype[methodName];
    
    // now install the wrapper
    cls.prototype[methodName] = function () {
        var args = Array.prototype.slice.call(arguments);
        
        // first, check if this call isn't need or if this is a subordinate call
        var sd = this.shadowDispatchChecks(className, methodName, className, args);
        if (sd.dispatched) {
            return sd.dispatchResult;
        }

        // if we know it's a main call, we flag it so that we don't split again further down the call chain
        this.shadowOptions.shadowSplit = true;
        
        // now do the main call
        var ret = this[dispatchedMethodName].apply(this, L.ShadowWrap.translateArgs(this, translate, args));
            
        // now dispatch the same call out to any shadow shapes that the main shape has
        // recheck means that some methods (e.g. addLatLng) need to recheck their shadows after the main call
        if (recheck) {
            var latlngs = (isSingle) ? [this._latlng] : this._latlngs;
            this.updatingShadowDispatch(dispatchedMethodName, translate !== null, args, latlngs);
        }
        else {
            this.shadowDispatch(dispatchedMethodName, translate, args);
        }
        
        // now clean up and return
        this.shadowOptions.shadowSplit = false;
        return ret;
    };
};

// this is for Polyline/Polygon ._setLatLngs and _convertLatLngs
// very similar to the above, but note that we are forced to always use the className in the method
// dispatch because those four methods are linked to each other via prototype calls. so, we basically
// need to manually orchestrate that.
L.ShadowWrap.installInheritedShadowMethod = function (cls, className, methodName) {
    var dispatchedMethodName = methodName + '__original' + className;
    
    cls.prototype[dispatchedMethodName] = cls.prototype[methodName];
    cls.prototype[methodName] = function (latlngs) {
        var sd = this.shadowDispatchChecks(className, methodName, className, [latlngs]);
        if (sd.dispatched) {
            return sd.dispatchResult;
        }
        
        this.shadowOptions.shadowSplit = true;
        var llo = this.updatingShadowDispatch(dispatchedMethodName, true, [], latlngs);
        
        var ret = this[dispatchedMethodName](llo.latlngs.normalizeLL);
        this.shadowOptions.shadowSplit = false;
        
        return ret;
    }; 
};

// for openTooltip/openPopup/addLatLng; we only translate the second arg, the latlng
L.ShadowWrap.translateArgs = function (shape, translationIndex, arglist) {
    if (translationIndex === null) {
        return arglist;
    }

    var translated = [];
    for (var i=0; i<arglist.length; i++) {
        if (i === translationIndex) {
            var t = shape[shape.shadowOptions.shadowType](arglist[i]);
            translated.push(t);
        }
        else {
            translated.push(arglist[i]);
        }
    }
    
    return translated;
};

// *************************************************************************************
// *************************************************************************************

L.ShadowWrap.SpecialMethods = {};

// allow L.Rectangle to be created from an array of coordinate tuples, as with L.Polyline
// and L.Polygon, to simplify some logic elsewhere
L.ShadowWrap.SpecialMethods._boundsToLatLngs = function (latLngBounds) {
    if (Array.isArray(latLngBounds) && (latLngBounds.length > 0)) {
        var conv = latLngBounds;
        if (Array.isArray(latLngBounds[0]) && (latLngBounds[0][0] instanceof L.LatLng)) {
            conv = latLngBounds[0];
        }
        
        var ll_latLngBounds = [];
        for (var i=0; i<conv.length; i++) {
            ll_latLngBounds.push(L.latLng(conv[i]));
        }
        latLngBounds = ll_latLngBounds;
    }
    
    return this._boundsToLatLngs__original(latLngBounds);
};

// *************************************************************************************
// *************************************************************************************

L.Layer.include({

    // this method's job is to calculate if we have any sort of wrap crossing for whatever particular shape we have
    // as opposed to the rest of this plugin, this part here is relatively straightforward
    calcShadow: function (latlngs) {
        var result = {
            'needsShadow': {
                'normLatMirrorLng': false,
                'mirrorLatNormLng': false,
                'mirrorLL': false
            },
            'latlngs': {
                'normalizeLL': latlngs,
                'mirrorLatNormLng': [],
                'normLatMirrorLng': [],
                'mirrorLL': []
            }
        };
    
        if ((!this._map) || (!this.shadowOptions.isShape)) {
            return result;
        }
    
        var i;
        var shadowType;
        
        var flat = true;
        if (!(this instanceof L.Marker) && !(this instanceof L.CircleMarker)) {
            flat = L.LineUtil.isFlat(latlngs);
        }
        
        result.latlngs.normalizeLL = [];
            
        if (flat) {
            for (i=0; i<latlngs.length; i++) {
                for (shadowType in result.latlngs) {
                    if (result.latlngs.hasOwnProperty(shadowType)) {
                        result.latlngs[shadowType].push(this[shadowType](latlngs[i]));
                    }
                }
            }
            
            for (i=0; i<latlngs.length; i++) {
                var j = (i == (latlngs.length-1)) ? 0 : (i+1);
                
                result.needsShadow.normLatMirrorLng = result.needsShadow.normLatMirrorLng
                                                   || this.checkWrap('lng', result.latlngs.normalizeLL, i);
                result.needsShadow.mirrorLatNormLng = result.needsShadow.mirrorLatNormLng
                                                   || this.checkWrap('lat', result.latlngs.normalizeLL, i);
            }
        }
        
        else {
            for (i=0; i<latlngs.length; i++) {
                var subShadow = this.calcShadow(latlngs[i]);
                    
                for (shadowType in result.latlngs) {
                    if (result.latlngs.hasOwnProperty(shadowType)) {
                        result.latlngs[shadowType].push(subShadow.latlngs[shadowType]);
                    }
                }
                
                result.needsShadow.normLatMirrorLng = result.needsShadow.normLatMirrorLng || subShadow.needsShadow.normLatMirrorLng;
                result.needsShadow.mirrorLatNormLng = result.needsShadow.mirrorLatNormLng || subShadow.needsShadow.mirrorLatNormLng;
                result.needsShadow.mirrorLL = result.needsShadow.mirrorLL || subShadow.needsShadow.mirrorLL;
            }
        }
        
        result.needsShadow.mirrorLL = result.needsShadow.normLatMirrorLng && result.needsShadow.mirrorLatNormLng;
        return result;
    },
    
    checkWrap: function (coord, latlngs, i) {
        var properCoordName = coord.substring(0, 1).toUpperCase() + coord.substring(1);
        
        if (! this._map.options.crs.hasOwnProperty('wrap' + properCoordName)) {
            return false;
        }
        
        if (!('shadowCheckType' in this.options)) {
            return false;
        }
    
        var crossPoints = this._map.options.crs['wrap' + properCoordName];
        
        if (this.options.shadowCheckType == 'cross') {
            return this.checkWrapCrossing(coord, crossPoints, latlngs, i);
        }
        else if (this.options.shadowCheckType == 'circle') {
        
            // circles have their radius specified in kilometers, so we need to
            // pseudo-convert to lng to see if our circle cross the meridian
            var radiusLL = this.options.radius;
            if (this._map.options.crs.hasOwnProperty('R') && (this._map.options.crs.R !== null)) {
                radiusLL = radiusLL*(180/Math.PI/this._map.options.crs.R);
            }
        
            return this.checkWrapPoint(coord, crossPoints, latlngs, i, radiusLL);
        }
        else if (this.options.shadowCheckType == 'point') {
            return this.checkWrapPoint(coord, crossPoints, latlngs, i, 0);
        }
    },
    
    checkWrapCrossing: function (coord, crossPoints, latlngs, i) {
        var j = i-1;
        if (i==0) {
            // polylines don't connect the first and last point, so no need to check
            if (! (this instanceof L.Polygon)) {
                return false;
            }
            
            j = latlngs.length - 1;
        }
        
        var crossA = ((latlngs[i][coord]-crossPoints[0]) > L.ShadowWrap.minimumWrapDistance)
                  && ((latlngs[j][coord]-crossPoints[0]) <= L.ShadowWrap.minimumWrapDistance);
        var crossB = ((latlngs[i][coord]-crossPoints[0]) <= L.ShadowWrap.minimumWrapDistance)
                  && ((latlngs[j][coord]-crossPoints[0]) > L.ShadowWrap.minimumWrapDistance);
        var crossC = ((latlngs[i][coord]-crossPoints[1]) > L.ShadowWrap.minimumWrapDistance)
                  && ((latlngs[j][coord]-crossPoints[1]) <= L.ShadowWrap.minimumWrapDistance);
        var crossD = ((latlngs[i][coord]-crossPoints[1]) <= L.ShadowWrap.minimumWrapDistance)
                  && ((latlngs[j][coord]-crossPoints[1]) > L.ShadowWrap.minimumWrapDistance);
        
        if (crossA || crossB || crossC || crossD) {
            return true;
        }
        
        return false;
    },
    
    checkWrapPoint: function (coord, crossPoints, latlngs, i, LLradius) {
        var crossA = (latlngs[i][coord]-LLradius-crossPoints[0]) <= L.ShadowWrap.minimumWrapDistance;
        var crossB = (latlngs[i][coord]-LLradius-crossPoints[1]) <= L.ShadowWrap.minimumWrapDistance;
        
        if (crossA || crossB) {
            return true;
        }
        
        return false;
    },
    
    normLat: function (latlng) {
        if (this._map.options.crs.hasOwnProperty('wrapLat')) {
            var wrapLatMidpoint = (this._map.options.crs.wrapLat[0] + this._map.options.crs.wrapLat[1])/2;
            if (latlng.lat > wrapLatMidpoint) {
                latlng.lat = latlng.lat - Math.abs(this._map.options.crs.wrapLat[1] - this._map.options.crs.wrapLat[0]);
            }
        }
        
        return latlng;
    },

    normLng: function (latlng) {
        if (this._map.options.crs.hasOwnProperty('wrapLng')) {
            var wrapLngMidpoint = (this._map.options.crs.wrapLng[0] + this._map.options.crs.wrapLng[1])/2;
            if (latlng.lng > wrapLngMidpoint) {
                latlng.lng = latlng.lng - Math.abs(this._map.options.crs.wrapLng[1] - this._map.options.crs.wrapLng[0]);
            }
        }
        
        return latlng;
    },

    mirrorLat: function (latlng) {
        if (this._map.options.crs.hasOwnProperty('wrapLat')) {
            var wrapLatMidpoint = (this._map.options.crs.wrapLat[0] + this._map.options.crs.wrapLat[1])/2;
            if (latlng.lat <= wrapLatMidpoint) {
                latlng.lat = latlng.lat + Math.abs(this._map.options.crs.wrapLat[1] - this._map.options.crs.wrapLat[0]);
            }
        }
        
        return latlng;
    },

    mirrorLng: function (latlng) {
        if (this._map.options.crs.hasOwnProperty('wrapLng')) {
            var wrapLngMidpoint = (this._map.options.crs.wrapLng[0] + this._map.options.crs.wrapLng[1])/2;
            if (latlng.lng <= wrapLngMidpoint) {
                latlng.lng = latlng.lng + Math.abs(this._map.options.crs.wrapLng[1] - this._map.options.crs.wrapLng[0]);
            }
        }
        
        return latlng;
    },

    normalizeLL: function (latlng) {
        var ll = this._map.options.crs.wrapLatLng(L.latLng(latlng));
        this.normLat(ll);
        this.normLng(ll);
        return ll;
    },

    normLatMirrorLng: function (latlng) {
        var ll = this._map.options.crs.wrapLatLng(L.latLng(latlng));
        this.normLat(ll);
        this.mirrorLng(ll);
        return ll;
    },

    mirrorLatNormLng: function (latlng) {
        var ll = this._map.options.crs.wrapLatLng(L.latLng(latlng));
        this.mirrorLat(ll);
        this.normLng(ll);
        return ll;
    },
        
    mirrorLL: function (latlng) {
        var ll = this._map.options.crs.wrapLatLng(L.latLng(latlng));
        this.mirrorLat(ll);
        this.mirrorLng(ll);
        return ll;
    }
});

// *************************************************************************************
// *************************************************************************************

// polygon and rect will inherit from polyline, so we only need to include once here
L.Layer.include({
    addShadows: function () {
        if (this.shadowOptions.isShadow) {
            return;
        }
    
        var isSingle = (this.options.shadowCheckType != 'cross');
        var llo = this.calcShadow((isSingle) ? [this._latlng] : this._latlngs);
        
        // if we've just been added to the map, then our main's shape's coordinates
        // haven't been normalized yet. so we should set them now, using the 
        // coordinates we've just so conveniently calculated
        
        if (isSingle) {
            this._latlng = llo.latlngs.normalizeLL[0];
        }
        else {
            if (this instanceof L.Polyline) {
                this._setLatLngs__originalPolyline(llo.latlngs.normalizeLL);
            }
            else {
                this._setLatLngs__originalPolygon(llo.latlngs.normalizeLL);
            }
        }
        
        this.changeShadows(llo);
        this._fixShape();
    },
    
    removeAllShadows: function () {
        if (this.shadowOptions.isShadow) {
            return;
        }
        
        for (var shadowType in this.shadowOptions.shadowShapes) {
            if (this.shadowOptions.shadowShapes.hasOwnProperty(shadowType)) {
                this._removeShadow(shadowType);
            }
        }
    },
    
    // add or remove any shadows based on calculations done by calcShadow
    changeShadows: function (llo) {
        if (this.shadowOptions.isShadow) {
            return;
        }
    
        var changed = {};
        for (var shadowType in llo.needsShadow) {
            if (llo.needsShadow.hasOwnProperty(shadowType)) {
                var n = llo.needsShadow[shadowType];
                var o = this.shadowOptions.shadowShapes.hasOwnProperty(shadowType);
                if (n && !o) {
                    changed[shadowType] = true;
                    this._addShadow(shadowType, llo.latlngs[shadowType]);
                }
                else if (!n && o) {
                    changed[shadowType] = true;
                    this._removeShadow(shadowType);
                }
            }
        }
        
        return changed;
    },
    
    // *************************************************************************************
    // *************************************************************************************

    // dispatch our method call to whatever shadow shapes our main shape has
    shadowDispatch: function (dispatchedMethodName, translate, args) {
        for (var shadowType in this.shadowOptions.shadowShapes) {
            if (this.shadowOptions.shadowShapes.hasOwnProperty(shadowType)) {
                var shadowShape = this.shadowOptions.shadowShapes[shadowType];
                shadowShape.shadowOptions.secondaryExecutor = true;
                
                var passedArgs = L.ShadowWrap.translateArgs(shadowShape, translate, args);
                shadowShape[dispatchedMethodName].apply(shadowShape, passedArgs);
                shadowShape.shadowOptions.secondaryExecutor = false;
            }
        }
    },
    
    // first, update our latlngs, create/remove any shadows that need be, and then dispatch
    // our method call to whatever shadow shapes our main shape has
    updatingShadowDispatch: function (dispatchedMethodName, translate, args, latlngs) {
        var isSingle = (this.options.shadowCheckType != 'cross');
        var llo = this.calcShadow(latlngs);
        var changed = this.changeShadows(llo);
        
        for (var shadowType in this.shadowOptions.shadowShapes) {
            if (this.shadowOptions.shadowShapes.hasOwnProperty(shadowType)) {
                if (changed.hasOwnProperty(shadowType)) {
                    continue;
                }
            
                var shadowShape = this.shadowOptions.shadowShapes[shadowType];
                shadowShape.shadowOptions.secondaryExecutor = true;
                
                if (translate === true) {
                    args = (isSingle) ? llo.latlngs[shadowType] : [llo.latlngs[shadowType]];
                }
                
                shadowShape[dispatchedMethodName].apply(shadowShape, args);
                shadowShape.shadowOptions.secondaryExecutor = false;
            }
        }
        
        return llo;
    },
    
    // general helper function to see if we don't need to bother with shadow dispatching, for a variety of reasons
    shadowDispatchChecks: function (className, methodName, dispatchTag, args) {
        var dispatchedMethodName = methodName + '__original' + dispatchTag;
        // if we're not added to the map, or if this shape doesn't have shadow hooks for some reason, bail
        if ((!this._map) || (!this.hasOwnProperty('shadowOptions')) || (!this.shadowOptions.isShape)) {
            return {
                'dispatched': true, 
                'dispatchResult': this[dispatchedMethodName].apply(this, args)
            };
        }
        
        // if this caller of this method is blocked on shadows, pretend we called it and bail
        if (this.shadowOptions.isShadow && L.ShadowWrap.checkExceptions(className, methodName, this)) {
            return {
                'dispatched': true,
                'dispatchResult': this
            };
        }
        
        // if our root call is on the shadow instead of the main shape, kick back up to the main shape
        if (this.shadowOptions.isShadow && (this.shadowOptions.secondaryExecutor === false)) {
            this.shadowOptions.secondaryExecutor = true;
            var primaryRet = this.shadowOptions.mainShape[methodName].apply(this.shadowOptions.mainShape, args);
            this.shadowOptions.secondaryExecutor = false;
            return {
                'dispatched': true, 
                'dispatchResult': primaryRet
            };
        }
        
        // if we've already gone through the main shape, then dispatch 
        if (this.shadowOptions.isShadow || this.shadowOptions.shadowSplit) {
            return {
                'dispatched': true,
                'dispatchResult': this[dispatchedMethodName].apply(this, args)
            };
        }
        
        return {'dispatched': false};
    },
    
    // actually create the shadow shape
    _addShadow: function (shadowType, latlngs) {
        var cls = Object.getPrototypeOf(this).constructor;
        
        var shadowOpts = L.extend({}, this.shadowOptions);
        delete shadowOpts.nonBubblingEvents;
        shadowOpts.isShadow = true;
        
        var shadowShape;
        if (this instanceof L.CircleMarker) {
            shadowShape = new cls(latlngs[0], this.options.radius, shadowOpts);
        }
        else if (this instanceof L.Marker) {
            shadowShape = new cls(latlngs[0], shadowOpts);
        }
        else {
            shadowShape = new cls(latlngs, shadowOpts);
        }
        
        this.shadowOptions.shadowShapes[shadowType] = shadowShape;
        shadowShape.shadowOptions.mainShape = this;
        shadowShape.shadowOptions.isShadow = true;
        shadowShape.shadowOptions.shadowType = shadowType;
        
        for (var i=0; i<L.ShadowWrap.EventsToShadow.length; i++) {
            var eventName = L.ShadowWrap.EventsToShadow[i];
            this._makeShadowEventHandler(shadowType, eventName);
        }
        
        shadowShape.addTo(this._map);
        shadowShape._fixShape();
        
        this.fire('shadowAdded', {
            'shadowLayer': shadowShape,
            'shadowType': shadowType
        });
    },
    
    _makeShadowEventHandler: function (shadowType, eventName) {
        var that = this;
        var shadowShape = this.shadowOptions.shadowShapes[shadowType];
        
        shadowShape.on(eventName, function () {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(eventName);
            that.fire.apply(that, args);
        }, this);
    },
    
    _fixShape: function () {
        if ('redraw__original' in this) { 
            this._reset__original();
            this.redraw__original();
        }
        else {
            this.update__original();
        }
    },
    
    _removeShadow: function (shadowType) {
        if (this.shadowOptions.isShadow) {
            return;
        }
        
        var shadowShape = this.shadowOptions.shadowShapes[shadowType];
        shadowShape.removeFrom(shadowShape._map);
        this.fire('shadowRemoved', {
            'shadowLayer': shadowShape,
            'shadowType': shadowShape.shadowOptions.shadowType
        });
        
        delete this.shadowOptions.shadowShapes[shadowType];
    },
});

// *************************************************************************************
// *************************************************************************************
// extra stuff to get leaflet draw to work right

// propagate changes in the shape to leaflet.draw's edit markers
L.ShadowWrap.DrawShadowUpdate = function (shape) {
    if (shape.editing._repositionCornerMarkers) {
        shape.editing._repositionCornerMarkers();
        shape.editing._moveMarker._latlng = shape.getCenter();
        shape.editing._moveMarker.update();
        return;
    }
    
    if (shape.editing._getResizeMarkerPoint) {
        shape.editing._moveMarker._latlng = shape.getCenter();
        shape.editing._moveMarker.update();
        var resizemarkerPoint = shape.editing._getResizeMarkerPoint(shape._moveMarker._latlng);
        shape._resizeMarkers[0].setLatLng(resizemarkerPoint);
        return;
    }

    if (shape.editing.updateMarkers) {
        shape.editing.updateMarkers();
        return;
    }
};

// propagate edit changes done to a main shape to the shadows, and vice versa
L.ShadowWrap.DrawShadowHooks = function () {
    if ((!this.editing) || (!this.shadowOptions)) {
        return;
    }
    
    if (this.shadowOptions.isShadow) {
        L.ShadowWrap.DrawShadowUpdate(this.shadowOptions.mainShape);
        L.ShadowWrap.DrawShadowHooks(this.shadowOptions.mainShape);
        return;
    }
        
    for (var shadowType in this.shadowOptions.shadowShapes) {
        if (this.shadowOptions.shadowShapes.hasOwnProperty(shadowType)) {
            L.ShadowWrap.DrawShadowUpdate(this.shadowOptions.shadowShapes[shadowType]);
        }
    }
};

L.ShadowWrap.initializeDrawShadowHooks = function () {
    this.on('move', L.ShadowWrap.DrawShadowHooks, this);
    this.on('resize', L.ShadowWrap.DrawShadowHooks, this);
    this.on('edit', L.ShadowWrap.DrawShadowHooks, this);
};

// hook into leaflet draw and leaflet snap; basically, add and remove shadow layers to drawnitems
// and the guideLayers as each main shape is.
L.ShadowWrap.hookLeafletDraw = function (drawnItems, snapGuideLayers, initialShapeList) {
    var leafletDrawCallback = function (ev) {
        drawnItems.addLayer(ev.layer);
        if (snapGuideLayers) {
            snapGuideLayers.push(ev.layer);
        }
        
        if (ev.layer.hasOwnProperty('shadowOptions')) {
            for (var shadowType in ev.layer.shadowOptions.shadowShapes) {
                if (ev.layer.shadowOptions.shadowShapes.hasOwnProperty(shadowType)) {
                    var shadowShape = ev.layer.shadowOptions.shadowShapes[shadowType];
                    
                    drawnItems.addLayer(shadowShape);
                    if (snapGuideLayers) {
                        snapGuideLayers.push(shadowShape);
                    }
                }
            }
        }
        
        ev.layer.on('shadowAdded', function (e) {
            drawnItems.addLayer(e.shadowLayer);
            if (snapGuideLayers) {
                snapGuideLayers.push(e.shadowLayer);
            }
        });
        
        ev.layer.off('shadowRemoved', function (e) {
            drawnItems.removeLayer(e.shadowLayer);
            if (snapGuideLayers) {
                var slid = L.stamp(e.shadowLayer);
                
                for (var i=0; i<snapGuideLayers.length; i++) {
                    if (L.stamp(snapGuideLayers[i]) == slid) {
                        snapGuideLayers.splice(i, 1);
                        break;
                    }
                }
            }
        });
    };
    
    if ((initialShapeList === null) || (typeof(initialShapeList) == 'undefined')) {
        initialShapeList = [];
    }
    
    for (var i=0; i<initialShapeList.length; i++) {
        leafletDrawCallback({'layer': initialShapeList[i]});
    }
    
    map.on('draw:created', leafletDrawCallback);
};

// *************************************************************************************
// *************************************************************************************

// the main installation method, to be manually called in your main.js or whatever
// (the manual call is so that you can add stuff to L.ShadowWrap.EventsToShadow and
// L.ShadowWrap.MethodsToWrap if you have some sort of other plugin, or whatever)
L.ShadowWrap.initialize = function () {
    // for leaflet.textpath.js
    if (L.Polyline.prototype.hasOwnProperty('setText')) {
        L.ShadowWrap.MethodsToWrap['L.Polyline'].simple.push('setText');
    }

    for (var className in L.ShadowWrap.MethodsToWrap) {
        if (L.ShadowWrap.MethodsToWrap.hasOwnProperty(className)) {
            L.ShadowWrap.installShadowHooks(className, L.ShadowWrap.MethodsToWrap[className]);
        }
    }
        
    // for leaflet.draw.js
    if (L.Control.Draw) {
        L.Marker.addInitHook(L.ShadowWrap.initializeDrawShadowHooks);
        L.Polyline.addInitHook(L.ShadowWrap.initializeDrawShadowHooks);
        
        L.ShadowWrap.addShadowException('Path', 'setStyle', L.Edit.SimpleShape.prototype.removeHooks);
        L.ShadowWrap.addShadowException('Path', 'setStyle', L.Edit.PolyVerticesEdit.prototype.removeHooks);
    }
};