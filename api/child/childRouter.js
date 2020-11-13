const express = require('express');
const authRequired = require('../middleware/authRequired');
const Child = require('./childModel');
const dsModel = require('../dsService/dsModel.js');
const router = express.Router();
const jwt = require('jsonwebtoken');
const upload = require('../middleware/multer');
const multiUpload = upload.array('image', 5);
const singleUpload = upload.single('image');
const checkToken = require('../middleware/jwtRestricted');
const generateChecksum = require('../middleware/uploadFiles');
const getTextPrediction = require('../dsService/dsModel');

//token creator for our JWT
function createToken(user) {
  const payload = {
    sub: user.id,
    username: user.username,
  };
  const secret = process.env.JWTSECRET;
  const options = {
    expiresIn: '3h',
  };
  return jwt.sign(payload, secret, options);
}

router.get('/', function (req, res) {
  Child.findAll()
    .then((children) => {
      if (children) {
        res.status(200).json(children);
      } else {
        res.status(404).json({ message: 'No children found' });
      }
    })
    .catch(() => {
      res.status(500);
    });
});

//login endpoint for child
router.post('/:id', authRequired, function (req, res) {
  const id = String(req.params.id);
  if (req.body.pin) {
    //retrieve the parent from the db
    Child.findById(id)
      .then((child) => {
        //check the pin
        if (child.pin === req.body.pin) {
          //if the pin is correct make a token and get the dashboard data
          const token = createToken(child);
          //check for mission progress and make a db entry if none is found
          Child.getMissionProgress(req.params.id)
            .then((progress) => {
              if (progress) {
                res.status(200).json({
                  token: token,
                  child: {
                    id: child.id,
                    name: child.name,
                    username: child.username,
                    current_mission: child.current_mission,
                    avatar_url: child.avatar_url,
                  },
                  mission_progress: {
                    read: progress.read,
                    write: progress.write,
                    draw: progress.draw,
                  },
                });
              } else {
                Child.createMissionProgress(req.params.id)
                  .then((newProgress) => {
                    if (newProgress) {
                      res.status(200).json({
                        token: token,
                        child: {
                          id: child.id,
                          name: child.name,
                          username: child.username,
                          current_mission: child.current_mission,
                          avatar_url: child.avatar_url,
                        },
                        mission_progress: {
                          read: newProgress.read,
                          write: newProgress.write,
                          draw: newProgress.draw,
                        },
                      });
                    } else {
                      res.status(500).json({
                        message: 'error creating mission progress object',
                      });
                    }
                  })
                  .catch((err) => {
                    res.status(500).json({
                      error: err,
                      message: 'error retrieving mission progress object',
                    });
                  });
              }
            })
            .catch((err) => {
              res.status(500).json({
                error: err,
                message: 'error retrieving mission progress object',
              });
            });
        } else {
          res.status(400).json({
            message: 'incorrect pin',
          });
        }
      })
      .catch((err) => {
        res.status(400).json({
          message: 'there is no child with that ID',
          error: err,
        });
      });
  } else {
    res.status(400).json({
      message: 'please include a pin',
    });
  }
});

//get current mission endpoint
//check the token
router.get('/:id/mission', checkToken, function (req, res) {
  Child.findById(req.params.id)
    .then((child) => {
      Child.getCurrentMission(child.current_mission)
        .then((mission) => {
          if (mission) {
            res.status(200).json({
              ...mission,
            });
          } else {
            res.status(404).json({ message: 'no mission found' });
          }
        })
        .catch((err) => {
          res.status(500).json({
            message: 'error retrieving mission',
            error: err,
          });
        });
    })
    .catch((err) => {
      res.status(500).json({
        message: 'error retrieving child data',
        error: err,
      });
    });
});

router.get('/:id/progress', checkToken, (req, res) => {
  Child.findById(req.params.id)
    .then((child) => {
      if (child) {
        Child.getMissionProgress(child.id)
          .then((mission) => {
            res.status(200).json({ progress: mission });
          })
          .catch((err) => {
            res.status(500).json({ error: err });
          });
      } else {
        res.status(404).json({ message: 'child not found' });
      }
    })
    .catch((err) => {
      res.status(500).json({ error: err });
    });
});

router.put('/:id/mission/read', checkToken, (req, res) => {
  Child.findById(req.params.id)
    .then((child) => {
      if (child) {
        Child.updateProgress(child.id, 'read')
          .then((resp) => {
            res.status(200).json({ progress: resp[0] });
          })
          .catch((err) => {
            res.status(500).json({ message: 'There was an error', error: err });
          });
      } else {
        res.status(404).json({ message: 'Child not found.' });
      }
    })
    .catch((err) => {
      res.status(500).json({ message: 'There was an error', error: err });
    });
});

/**
 * Parse and save writing submission
 * @param images
 * @param child
 * @returns {Promise<any[]>}
 */
async function parseAndSaveSubmissions(images, child) {
  return Promise.all(
    images.map(async (url) => {
      try {
        // return writing scores and round it to nearest integer
        // let result = await dsModel.getTextPrediction(url);
        // console.log(result.data);
        let submissionObject = {
          file_path: url,
          score: Math.round(result.data),
          mission_id: child.current_mission,
          child_id: child.id,
        };
        try {
          await Child.addWriting(submissionObject);
        } catch (err) {
          console.log('error', err);
        }
        return true;
      } catch (e) {
        console.log('error', e);
        return false;
      }
    })
  );
}

/*
Front end submits mission_progress.id with images.

Once object is created, send to ds api
*/

//post writting submission
//use the multer function to send to the aws bucket and get the url's back
//send each of those url's to the ds endpoint to get scores and flags back
//add those scores and flags to the urls to make each post object
//add each of those post objects to the db
router.post('/:id/mission/write', checkToken, async function (req, res) {
  console.log('hi 1');
  let child = await Child.findById(req.params.id);
  console.log('hi 2');
  //we run the images through this multer function
  //we send our files to an AWS bucket
  //we get back an array of urls for the uploaded files
  multiUpload(req, res, async function (err) {
    console.log('hi 3');
    if (err) {
      console.log('hi 4');
      console.log(err.message);
      return res.status(500).json({
        status: 'fail',
        message: 'Error: No File Selected',
      });
    } else {
      if (req.files[0] === undefined) {
        console.log('hi 6');
        return res.json({ message: 'file undefined' });
      } else {
        console.log('hi 5');
        const fileArray = req.files;
        let fileLocation = '';
        const images = [];
        for (let i = 0; i < fileArray.length; i++) {
          fileLocation = fileArray[i].location;
          images.push(fileLocation);
        }
        //we get the scores and flags back
        const dsSubmit = {
          missionProgressID: 1,
          missionID: child.current_mission,
          pages: {},
        };
        images.map((result, i) => {
          const updateInd = i + 1;
          const pageObj = {
            url: result,
            checksum: generateChecksum(result),
          };
          dsSubmit.pages[updateInd] = pageObj;
        });
        //Response from dsSubmit:
        /*
        {
          missionProgressID: undefined,
          missionID: 1,
          pages: {
            '1': {
              url: 'https://storysquad-teamc-bucket.s3.amazonaws.com/user-content/1605118951973JB_SPICY_RAMEN_4K.jpg',  
              checksum: 'c0d68b9535e8a5d06c6d45ff48bd89eada2129a139666ea6028d66267ff5b2d041688ce8a8a258faf75e19e3f93846718d04720b7e49389b0fabad8727f896ad'
            }
          }
        }
        */
        //and construct the submission objects to save to the DB
        let submissions = [];
        //NOTE: We already have urls here because of multer; we just need to generate checksums for them
        console.log(dsSubmit);
        let result = await getTextPrediction(dsSubmit);
        console.log(result);
        for (let i = 0; i < images.length; i++) {
          let submissionObject = {
            file_path: dsSubmit.pages[i].url,
            // score: result.data,
            // flagged: result
            mission_id: child.current_mission,
            child_id: child.id,
          };
          submissions.push(submissionObject);
        }

        await parseAndSaveSubmissions(images, child);

        const mission = await Child.updateProgress(req.params.id, 'write');
        res.status(200).json({
          message: 'we got your submission!',
          progress: mission[0],
        });
      }
    }
  });
});

router.post('/:id/mission/draw', checkToken, async function (req, res) {
  let child = await Child.findById(req.params.id);

  singleUpload(req, res, async function (err) {
    if (err) {
      return res.status(500).json({
        status: 'fail',
        message: 'Error: No File Selected',
      });
    } else {
      if (req.file === undefined) {
        return res.json({ message: 'file undefined' });
      } else {
        let result = await dsModel.getTextPrediction(req.file.location);
        console.log(result.data);
        let submissionObject = {
          file_path: req.file.location,
          score: Math.round(result.data),
          mission_id: child.current_mission,
          child_id: child.id,
        };
        try {
          await Child.addDrawing(submissionObject);
        } catch (err) {
          console.log('error', err);
        }
        const mission = await Child.updateProgress(req.params.id, 'draw');
        res
          .status(200)
          .json({ message: 'we got your submission!', progress: mission[0] });
      }
    }
  });
});

//get past submissions
router.get('/:id/archive', checkToken, function (req, res) {
  Child.getArchive(req.params.id)
    .then((submissions) => {
      res.json({ submissions });
    })
    .catch((err) => {
      res.json({ err });
    });
});

module.exports = router;
