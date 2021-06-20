"use strict";

var axios = require("axios").default;
const klipInfo = require('../resource/klip.json');
var smHandler = require('./util_sm.js');
var FormData = require('form-data');

let klipLoginData = null; //login 이후에 엑세스 토큰은 해쉬값으로 접근

const getKlipLoginData = async() => {

    if (klipLoginData) {
        console.log('[getKlipLoginData] return info from cache')
        return {
            result: true,
            data: klipLoginData,
        }
    }
    else {
        const klipLoginResult = await requestLogin();
        console.log('[getKlipLoginData] return info from api')

        if (klipLoginResult.result) {
            klipLoginData = klipLoginResult.data;
            return {
                result: true,
                data: klipLoginResult.data
            }
        }
        else {
            console.log('[getKlipLoginData] return fail from api')

            return {
                result: false,
                data: klipLoginResult.data,
            }
        }
    }

}
const requestLogin = async() => {

    const secretValue = await smHandler.getSecretValue(process.env.KLIP_SM_ID);

    console.log('[requestLogin] secretValue', secretValue);

    const email = secretValue.email;
    const password = secretValue.password;

    // [TASK] Request Klip Check
    const axiosHeader = {
        'Content-Type': 'application/json',
    };

    const body = {
        email: email,
        password: password
    }

    console.log('[requestLogin] request klip partenr api auth')
    const klipPartnerLoginResult = await axios
        .post(
            `${klipInfo.partnerUrl}auth`, body, { headers: axiosHeader }
        )
        .catch((err) => {
            console.log('[Klip Partner Login - ERROR] err', err);
            return { error: err.response }
        });
    console.log('[requestLogin] klipPartnerLoginResult', klipPartnerLoginResult)
    if (!klipPartnerLoginResult.error) {
        console.log('[Klip - 400] response', klipPartnerLoginResult.error);
        const data = klipPartnerLoginResult.error.data;
        return {
            result: false,
            data: data
        }
    }
    else {
        // const data = klipPartnerLogin.data; 
        const temp_data = {
            "email": "ray.kim@groundx.xyz",
            "klaytn_address": 0xdc6AE5861a73d852bd3cdD84a4BA7f598A5160F3,
            "contract_address": "0xc94770007dda54cF92009BFF0dE90c06F603a09f",
            "name": "Ray Kim",
            "phone": "01077777777",
            "service_name": "판타지월드레볼루션",
            "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJI...",
            "status": 10,
            "mint_limit": 1000,
            "mint_count": 1,
        }
        klipLoginData = temp_data;
        return {
            result: true,
            data: temp_data,
        }

    }
}

const requestUploadImage = async(image_url) => {

    const klipLoginData = await getKlipLoginData();
    console.log('[requestUploadImage] klipLoginData', klipLoginData)
    let access_token = null;

    if (klipLoginData.result) {
        access_token = klipLoginData.data.access_token
    }
    else {
        return {
            result: false,
            code: klipLoginData.code,
            message: klipLoginData.message,
        }
    }
    console.log('[requestUploadImage] access_token', access_token)

    //[TASK] Request Klip Check
    const axiosHeader = {
        'Content-Type': 'multipart/form-data',
        'Authorization': access_token
    };

    var formData = new FormData();
    formData.append('upload', image_url);
    console.log('[requestUploadImage] formData', formData)

    const klipImageUploadResult = await axios
        .post(
            `${klipInfo.walletUrl}image`, formData, { headers: axiosHeader }
        )
        .catch((err) => {
            console.log('[requestUploadImage - ERROR] err', err);
            return { error: err.response }
        });

    if (!klipImageUploadResult.error) {
        console.log('[requestUploadImage - ERROR] response', klipImageUploadResult.error);
        const data = klipImageUploadResult.error.data;
        return {
            result: false,
            data: data,
        }
    }
    else {
        const temp_data = { "image": "https://path_to_image/image.png" }
        return {
            result: true,
            data: temp_data,
        }
    }
}


const requestCardMint = async(to_address, name, description, image_url, effect_dt, expire_dt) => {

    const secretValue = await smHandler.getSecretValue(process.env.KLIP_SM_ID);
    console.log('[requestCardMint] secretValue', secretValue)
    let info_json = {
        "pin": secretValue.pin,
        "to_address": [to_address],
        "contract_address": secretValue.contract_address,
        "name": name,
        "description": description,
        "image": image_url,
        "sendable": false,
        "send_friend_only": false,
        "layout": "general",
        "attributes": [{
            "trait_type": "effect_date",
            "value": effect_dt,

        }, {
            "trait_type": "expire_date",
            "value": expire_dt,

        }, ]
    }

    console.log('info_json', info_json);

    const klipLoginData = await getKlipLoginData();
    console.log('[requestCardMint] klipLoginData', klipLoginData)
    let access_token = null;

    if (klipLoginData.result) {
        access_token = klipLoginData.data.access_token
    }
    else {
        return {
            result: false,
            code: klipLoginData.code,
            message: klipLoginData.message,
        }
    }
    console.log('[requestCardMint] access_token', access_token)

    //[TASK] Request Klip Check
    const axiosHeader = {
        'Content-Type': 'application/json',
        'Authorization': access_token
    };

    const klipCardMintResult = await axios
        .post(
            `${klipInfo.walletUrl}mint`, info_json, { headers: axiosHeader }
        )
        .catch((err) => {
            console.log('[requestCardMint - ERROR] err', err);
            return { error: err.response }
        });

    if (!klipCardMintResult.error) {
        console.log('[requestCardMint - ERROR] response', klipCardMintResult.error);
        const data = klipCardMintResult.error.data;
        return {
            result: false,
            data: data,
        }
    }
    else {
        const temp_data = {
            // 0x3815249f37c9464a2151f09e4bc92fd8aa53c340f6f0537ddc36f945aa115900 success
            // 0x4edc1438f7defda5fc267ef11fc484edbed73d86480959eb57a5421a84fd7f59 commitError
            // 0x2d26f602cfbb4c662931592bf2c4ee18d29f09683be5b9e8d589ff935fca0b97 invliad hash
            "hash": "0x3815249f37c9464a2151f09e4bc92fd8aa53c340f6f0537ddc36f945aa115900"
        }
        return {
            result: true,
            data: temp_data,
        }
    }
}



module.exports = { requestLogin, requestUploadImage, requestCardMint }
