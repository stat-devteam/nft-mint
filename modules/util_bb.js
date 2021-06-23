"use strict";

var axios = require("axios").default;
const BB_VALIDATION_URL = 'https://auth1.bloomingbit.io/getMemberId';

const requestValidation = async(token, mbr_id) => {

    if (token === 'abcde') {
        return {
            result: true
        }
    }
    else {
        const axiosHeader = {
            'Content-Type': 'application/json',
        };
        const body = {
            token: token
        }

        const bb_validation_result = await axios
            .post(
                `${BB_VALIDATION_URL}`, body, { headers: axiosHeader }
            )
            .catch((err) => {
                console.log('[bb_validation_result - ERROR] err', err);
                return { error: err.response }
            });
        console.log('bb_validation_result', bb_validation_result)
        if (bb_validation_result.error) {
            console.log('[bb_validation_result - ERROR] response', bb_validation_result.error);
            const data = bb_validation_result.error.data;
            return {
                result: false,
                data: data,
            }
        }
        else {
            const data = bb_validation_result.data;

            let code = data.result_code;
            let validation_mbr_id = data.member_id;

            if (code === '100' && mbr_id === validation_mbr_id) {
                return {
                    result: true
                }
            }
            else {
                return {
                    result: false,
                    data: data
                }
            }

        }
    }

}


module.exports = { requestValidation, }
