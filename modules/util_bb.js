"use strict";

var axios = require("axios").default;

const requestValidation = async(token) => {

    if (token === 'abcde') {
        return {
            result: true
        }
    }
    else {
        return {
            result: false
        }
    }

}


module.exports = { requestValidation, }
